import {
  isProviderExecutionPolicy,
  isProviderExecutionTarget,
  isProviderRuntime,
  PRODUCTION_PROVIDER_EXECUTION_POLICY,
  type PipelineFailureEnvelope,
  type ProviderExecutionAttempt,
  type ProviderExecutionModel,
  type ProviderExecutionPolicy,
  type ProviderExecutionReport,
  type ProviderExecutionSession,
  type ProviderExecutionStage,
  type ProviderExecutionTarget,
  type ProviderExecutionModelMetadata,
  type ProviderRuntime,
} from '@shinobu/image-pipeline';

type ProviderSessionLoader = (
  model: ProviderExecutionModel,
  providers: readonly ProviderRuntime[],
) => Promise<ProviderExecutionSession>;

export type ProviderSessionResolverOptions = {
  policy?: ProviderExecutionPolicy;
  loadModel: (
    model: ProviderExecutionModel,
  ) => Promise<ProviderExecutionModelMetadata>;
  loadSession: ProviderSessionLoader;
};

export type ProviderExecutionRequest<T> = ProviderExecutionTarget & {
  run(session: ProviderExecutionSession): Promise<T>;
};

export type ProviderExecutionResult<T> = {
  value: T;
  report: ProviderExecutionReport;
};

export type ProviderExecutionPreloadResult = ProviderExecutionTarget & {
  provider: ProviderRuntime;
  webnnDeviceType?: ProviderExecutionSession['webnnDeviceType'];
};

export type ProviderSessionResolver = {
  preload(
    target: ProviderExecutionTarget,
  ): Promise<ProviderExecutionPreloadResult>;
  execute<T>(
    request: ProviderExecutionRequest<T>,
  ): Promise<ProviderExecutionResult<T>>;
};

type PreparedProviderExecution = {
  providers: ProviderRuntime[];
  attempts: ProviderExecutionAttempt[];
  providerIndex: number;
  session: ProviderExecutionSession;
};

function assertPolicy(policy: ProviderExecutionPolicy): void {
  if (!isProviderExecutionPolicy(policy)) {
    throw new TypeError('Provider execution policy contract is invalid');
  }
}

function clonePolicy(
  policy: ProviderExecutionPolicy,
): ProviderExecutionPolicy {
  return {
    schemaVersion: 1,
    contract: { ...policy.contract },
    rules: policy.rules.map((rule) => ({
      ...rule,
      providers: [...rule.providers],
    })),
  };
}

function createReport(
  policy: ProviderExecutionPolicy,
  model: ProviderExecutionModel,
  stage: ProviderExecutionStage,
  attempts: ProviderExecutionAttempt[],
  finalProvider?: ProviderRuntime,
): ProviderExecutionReport {
  const fallbackTrace = attempts.slice(1).map((attempt, index) => ({
    from: attempts[index].provider,
    to: attempt.provider,
    reason: attempts[index].reason,
  }));
  return {
    schemaVersion: 1,
    contract: { ...policy.contract },
    model,
    stage,
    attempts: attempts.map((attempt) => ({ ...attempt })),
    finalProvider,
    fallbackTrace,
    satisfied: finalProvider !== undefined,
  };
}

function failureFor(
  code:
    | 'PIPELINE_PROVIDER_UNAVAILABLE'
    | 'PIPELINE_PROVIDER_EXECUTION_FAILED'
    | 'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
  report: ProviderExecutionReport,
): PipelineFailureEnvelope {
  const messageKey = code === 'PIPELINE_PROVIDER_UNAVAILABLE'
    ? 'pipeline.failure.providerUnavailable'
    : code === 'PIPELINE_PROVIDER_EXECUTION_FAILED'
      ? 'pipeline.failure.providerExecution'
      : 'pipeline.failure.providerContract';
  return {
    code,
    stage: report.stage,
    scope: 'runtime',
    retryable: false,
    messageKey,
    diagnostics: {
      contract: report.contract,
      model: report.model,
      report,
    },
  };
}

export class ProviderExecutionError extends Error {
  constructor(
    readonly failure: PipelineFailureEnvelope,
    readonly report: ProviderExecutionReport,
    cause?: unknown,
  ) {
    super(failure.messageKey, cause === undefined ? undefined : { cause });
    this.name = 'ProviderExecutionError';
  }
}

export class ProviderPostProcessingError extends Error {
  constructor(
    cause: unknown,
    readonly providerReports: ProviderExecutionReport[],
  ) {
    super(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
    this.name = 'ProviderPostProcessingError';
  }
}

function throwProviderFailure(
  code: Parameters<typeof failureFor>[0],
  report: ProviderExecutionReport,
  cause?: unknown,
): never {
  throw new ProviderExecutionError(failureFor(code, report), report, cause);
}

export function createProviderSessionResolver(
  options: ProviderSessionResolverOptions,
): ProviderSessionResolver {
  if (!options.loadModel || !options.loadSession) {
    throw new TypeError('Provider model/session capability is required');
  }
  const policySource = options.policy ?? PRODUCTION_PROVIDER_EXECUTION_POLICY;
  const loadModel = options.loadModel;
  const loadSession = options.loadSession;
  assertPolicy(policySource);
  const policy = clonePolicy(policySource);
  const preparedExecutions = new Map<string, PreparedProviderExecution>();

  function assertTarget(
    model: unknown,
    stage: unknown,
  ): asserts model is ProviderExecutionModel {
    if (!isProviderExecutionTarget(model, stage)) {
      throw new TypeError('Provider execution target is invalid');
    }
  }
  const targetKey = (
    model: ProviderExecutionModel,
    stage: ProviderExecutionStage,
  ): string => `${stage}:${model}`;
  const resolveProviders = async (
    model: ProviderExecutionModel,
    stage: ProviderExecutionStage,
  ): Promise<ProviderRuntime[]> => {
    const rule = policy.rules.find((candidate) =>
      candidate.model === model && candidate.stage === stage);
    let manifestProviders: readonly ProviderRuntime[] | undefined;
    if (!rule) {
      try {
        manifestProviders = (await loadModel(model)).runtime;
      } catch (error) {
        throwProviderFailure(
          'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
          createReport(policy, model, stage, []),
          error,
        );
      }
    }
    const providers = [...(rule?.providers ?? manifestProviders ?? [])];
    if (
      providers.length === 0
      || !providers.every(isProviderRuntime)
      || new Set(providers).size !== providers.length
    ) {
      throwProviderFailure(
        'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
        createReport(policy, model, stage, []),
      );
    }
    return providers;
  };
  const acquireSession = async (
    model: ProviderExecutionModel,
    stage: ProviderExecutionStage,
    provider: ProviderRuntime,
    attempts: ProviderExecutionAttempt[],
    onUnavailable?: (error: unknown) => void,
  ): Promise<ProviderExecutionSession | null> => {
    let session: ProviderExecutionSession;
    try {
      session = await loadSession(model, [provider]);
    } catch (error) {
      onUnavailable?.(error);
      attempts.push({
        attempt: attempts.length + 1,
        provider,
        outcome: 'unavailable',
        reason: 'session-unavailable',
      });
      return null;
    }
    if (session.provider !== provider) {
      attempts.push({
        attempt: attempts.length + 1,
        provider,
        outcome: 'failed',
        reason: 'contract-violated',
      });
      throwProviderFailure(
        'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
        createReport(policy, model, stage, attempts),
      );
    }
    return session;
  };
  const preloadResult = (
    target: ProviderExecutionTarget,
    session: ProviderExecutionSession,
  ): ProviderExecutionPreloadResult => ({
    ...target,
    provider: session.provider,
    ...(session.webnnDeviceType
      ? { webnnDeviceType: session.webnnDeviceType }
      : {}),
  } as ProviderExecutionPreloadResult);

  return {
    async preload(
      target: ProviderExecutionTarget,
    ): Promise<ProviderExecutionPreloadResult> {
      const { model, stage } = target;
      assertTarget(model, stage);
      const key = targetKey(model, stage);
      const existing = preparedExecutions.get(key);
      if (existing) {
        return preloadResult(target, existing.session);
      }

      const providers = await resolveProviders(model, stage);
      const attempts: ProviderExecutionAttempt[] = [];
      let lastError: unknown;
      for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
        const provider = providers[providerIndex];
        const session = await acquireSession(
          model,
          stage,
          provider,
          attempts,
          (error) => {
            lastError = error;
          },
        );
        if (!session) continue;
        preparedExecutions.set(key, {
          providers,
          attempts,
          providerIndex,
          session,
        });
        return preloadResult(target, session);
      }
      throwProviderFailure(
        'PIPELINE_PROVIDER_UNAVAILABLE',
        createReport(policy, model, stage, attempts),
        lastError,
      );
    },

    async execute<T>({
      model,
      stage,
      run,
    }: ProviderExecutionRequest<T>): Promise<ProviderExecutionResult<T>> {
      assertTarget(model, stage);
      const key = targetKey(model, stage);
      const prepared = preparedExecutions.get(key);
      preparedExecutions.delete(key);
      const providers = prepared?.providers
        ?? await resolveProviders(model, stage);
      const attempts = prepared?.attempts.map((attempt) => ({ ...attempt }))
        ?? [];

      let lastError: unknown;
      let executionFailed = false;
      const firstProviderIndex = prepared?.providerIndex ?? 0;
      for (
        let providerIndex = firstProviderIndex;
        providerIndex < providers.length;
        providerIndex += 1
      ) {
        const provider = providers[providerIndex];
        const attempt = attempts.length + 1;
        let session: ProviderExecutionSession;
        if (prepared && providerIndex === prepared.providerIndex) {
          session = prepared.session;
        } else {
          const acquired = await acquireSession(
            model,
            stage,
            provider,
            attempts,
            (error) => {
              lastError = error;
            },
          );
          if (!acquired) continue;
          session = acquired;
        }

        try {
          const value = await run(session);
          attempts.push({
            attempt,
            provider,
            outcome: 'succeeded',
            reason: 'completed',
          });
          return {
            value,
            report: createReport(policy, model, stage, attempts, provider),
          };
        } catch (error) {
          lastError = error;
          executionFailed = true;
          attempts.push({
            attempt,
            provider,
            outcome: 'failed',
            reason: 'execution-failed',
          });
        }
      }

      const report = createReport(policy, model, stage, attempts);
      throwProviderFailure(
        executionFailed
          ? 'PIPELINE_PROVIDER_EXECUTION_FAILED'
          : 'PIPELINE_PROVIDER_UNAVAILABLE',
        report,
        lastError,
      );
    },
  };
}
