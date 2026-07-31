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
import { ProviderSessionLostError } from './onnxWorkerTypes';

export { ProviderSessionLostError } from './onnxWorkerTypes';

type ProviderSessionLoader = (
  model: ProviderExecutionModel,
  provider: ProviderRuntime,
) => Promise<ProviderExecutionSession>;

export type ProviderSessionResolverOptions = {
  policy?: ProviderExecutionPolicy;
  loadModel: (
    model: ProviderExecutionModel,
  ) => Promise<ProviderExecutionModelMetadata>;
  loadSession: ProviderSessionLoader;
  resetRuntime?: () => Promise<void>;
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

export class ProviderSessionContractError extends Error {
  readonly code = 'PIPELINE_PROVIDER_CONTRACT_VIOLATED';
  readonly reason = 'contract-violated';

  constructor(
    requestedProvider: ProviderRuntime,
    actualProvider: ProviderRuntime,
    cleanup: 'succeeded' | 'failed',
    recovery: 'not-required' | 'runtime-reset' | 'runtime-reset-failed',
  ) {
    super('pipeline.failure.providerContract', {
      cause: {
        requestedProvider,
        actualProvider,
        cleanup,
        recovery,
      },
    });
    this.name = 'ProviderSessionContractError';
  }
}

type PreparedProviderExecution = {
  providers: ProviderRuntime[];
  attempts: ProviderExecutionAttempt[];
  providerIndex: number;
  session: ProviderExecutionSession;
};

const WEBGPU_SESSION_RECOVERY_MAX_ATTEMPTS = 3;
const WEBGPU_SESSION_RECOVERY_WAIT_BUDGET_MS = 30_000;
const WEBGPU_SESSION_RECOVERY_DELAY_MS = 120;

class ProviderRecoveryBudgetExceededError extends Error {
  constructor() {
    super('pipeline.failure.providerRecoveryBudgetExceeded');
    this.name = 'ProviderRecoveryBudgetExceededError';
  }
}

async function runWithinRecoveryBudget<T>(
  deadline: number,
  operation: () => Promise<T>,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new ProviderRecoveryBudgetExceededError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderRecoveryBudgetExceededError()),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function waitWithinRecoveryBudget(deadline: number): Promise<void> {
  return runWithinRecoveryBudget(
    deadline,
    () => new Promise((resolve) => {
      setTimeout(resolve, WEBGPU_SESSION_RECOVERY_DELAY_MS);
    }),
  );
}

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
  requiredProviders: readonly ProviderRuntime[],
  attempts: ProviderExecutionAttempt[],
  finalProvider?: ProviderRuntime,
): ProviderExecutionReport {
  const fallbackTrace = attempts.slice(1).flatMap((attempt, index) => {
    const previous = attempts[index];
    return previous.provider === attempt.provider
      ? []
      : [{
          from: previous.provider,
          to: attempt.provider,
          reason: previous.reason,
        }];
  });
  return {
    schemaVersion: 1,
    contract: { ...policy.contract },
    model,
    stage,
    requiredProviders: [...requiredProviders],
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
  const resetRuntime = options.resetRuntime;
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
          createReport(policy, model, stage, [], []),
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
        createReport(policy, model, stage, providers, []),
      );
    }
    return providers;
  };
  const acquireSession = async (
    model: ProviderExecutionModel,
    stage: ProviderExecutionStage,
    requiredProviders: readonly ProviderRuntime[],
    provider: ProviderRuntime,
    attempts: ProviderExecutionAttempt[],
    onUnavailable?: (error: unknown) => void,
    recoveryDeadline?: number,
  ): Promise<ProviderExecutionSession | null> => {
    let session: ProviderExecutionSession;
    try {
      session = recoveryDeadline === undefined
        ? await loadSession(model, provider)
        : await runWithinRecoveryBudget(
            recoveryDeadline,
            () => loadSession(model, provider),
          );
    } catch (error) {
      if (error instanceof ProviderRecoveryBudgetExceededError) throw error;
      if (error instanceof ProviderSessionContractError) {
        attempts.push({
          attempt: attempts.length + 1,
          provider,
          outcome: 'failed',
          reason: 'contract-violated',
        });
        throwProviderFailure(
          'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
          createReport(
            policy,
            model,
            stage,
            requiredProviders,
            attempts,
          ),
          error,
        );
      }
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
        createReport(policy, model, stage, requiredProviders, attempts),
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
          providers,
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
        createReport(policy, model, stage, providers, attempts),
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
        let session: ProviderExecutionSession;
        if (prepared && providerIndex === prepared.providerIndex) {
          session = prepared.session;
        } else {
          const acquired = await acquireSession(
            model,
            stage,
            providers,
            provider,
            attempts,
            (error) => {
              lastError = error;
            },
          );
          if (!acquired) continue;
          session = acquired;
        }

        const maxSessionAttempts = provider === 'webgpu' && resetRuntime
          ? WEBGPU_SESSION_RECOVERY_MAX_ATTEMPTS
          : 1;
        let recoveryDeadline: number | undefined;
        for (
          let sessionAttempt = 1;
          sessionAttempt <= maxSessionAttempts;
          sessionAttempt += 1
        ) {
          const attempt = attempts.length + 1;
          try {
            const value = recoveryDeadline === undefined
              ? await run(session)
              : await runWithinRecoveryBudget(
                  recoveryDeadline,
                  () => run(session),
                );
            attempts.push({
              attempt,
              provider,
              outcome: 'succeeded',
              reason: 'completed',
            });
            return {
              value,
              report: createReport(
                policy,
                model,
                stage,
                providers,
                attempts,
                provider,
              ),
            };
          } catch (error) {
            lastError = error;
            executionFailed = true;
            const sessionLost = error instanceof ProviderSessionLostError
              && provider === 'webgpu';
            attempts.push({
              attempt,
              provider,
              outcome: 'failed',
              reason: sessionLost ? 'session-lost' : 'execution-failed',
            });
            if (
              sessionLost
              && resetRuntime
              && sessionAttempt < maxSessionAttempts
            ) {
              try {
                recoveryDeadline ??= Date.now()
                  + WEBGPU_SESSION_RECOVERY_WAIT_BUDGET_MS;
                await waitWithinRecoveryBudget(recoveryDeadline);
                await runWithinRecoveryBudget(
                  recoveryDeadline,
                  resetRuntime,
                );
                const recovered = await acquireSession(
                  model,
                  stage,
                  providers,
                  provider,
                  attempts,
                  (recoveryError) => {
                    lastError = recoveryError;
                  },
                  recoveryDeadline,
                );
                if (!recovered) break;
                session = recovered;
                continue;
              } catch (recoveryError) {
                lastError = recoveryError;
              }
            }
            if (stage === 'detect') {
              throwProviderFailure(
                'PIPELINE_PROVIDER_EXECUTION_FAILED',
                createReport(policy, model, stage, providers, attempts),
                error,
              );
            }
            break;
          }
        }
        if (stage === 'detect' && executionFailed) {
          throwProviderFailure(
            'PIPELINE_PROVIDER_EXECUTION_FAILED',
            createReport(policy, model, stage, providers, attempts),
            lastError,
          );
        }
      }

      const report = createReport(policy, model, stage, providers, attempts);
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
