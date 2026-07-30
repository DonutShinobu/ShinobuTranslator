import {
  PRODUCTION_PROVIDER_EXECUTION_POLICY,
  type PipelineFailureEnvelope,
  type ProviderExecutionAttempt,
  type ProviderExecutionModel,
  type ProviderExecutionPolicy,
  type ProviderExecutionReport,
  type ProviderExecutionStage,
  type ProviderRuntime,
} from '@shinobu/image-pipeline';
import {
  getModel,
  getModelSession,
  type ModelName,
} from './modelRegistry';
import type { WorkerSessionHandle } from './onnxWorkerTypes';

type ProviderModelMetadata = {
  runtime?: readonly ProviderRuntime[];
};

type ProviderSessionLoader = (
  model: ProviderExecutionModel,
  providers: ProviderRuntime[],
) => Promise<WorkerSessionHandle>;

export type ProviderSessionResolverOptions = {
  policy?: ProviderExecutionPolicy;
  loadModel?: (
    model: ProviderExecutionModel,
  ) => Promise<ProviderModelMetadata>;
  loadSession?: ProviderSessionLoader;
};

export type ProviderExecutionRequest<T> = {
  model: ProviderExecutionModel;
  stage: ProviderExecutionStage;
  run(session: WorkerSessionHandle): Promise<T>;
};

export type ProviderExecutionResult<T> = {
  value: T;
  report: ProviderExecutionReport;
};

export type ProviderSessionResolver = {
  execute<T>(
    request: ProviderExecutionRequest<T>,
  ): Promise<ProviderExecutionResult<T>>;
};

const supportedProviders = new Set<ProviderRuntime>([
  'webgpu',
  'webnn',
  'wasm',
  'cuda',
  'cpu',
]);
const supportedModels = new Set<ProviderExecutionModel>([
  'detector',
  'bubble',
  'paddleocr_v6_medium_rec',
  'inpaint',
]);
const supportedStages = new Set<ProviderExecutionStage>([
  'detect',
  'bubble',
  'ocr',
  'inpaint',
]);
const supportedTargets = new Set([
  'detect:detector',
  'bubble:bubble',
  'ocr:paddleocr_v6_medium_rec',
  'inpaint:inpaint',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function assertPolicy(policy: ProviderExecutionPolicy): void {
  const value = policy as unknown;
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'contract', 'rules'])
    || value.schemaVersion !== 1
    || !isRecord(value.contract)
    || !hasOnlyKeys(value.contract, ['id', 'version'])
    || typeof value.contract.id !== 'string'
    || !value.contract.id.trim()
    || !Number.isInteger(value.contract.version)
    || (value.contract.version as number) < 1
    || !Array.isArray(value.rules)
  ) {
    throw new TypeError('Provider execution policy contract is invalid');
  }

  const targets = new Set<string>();
  for (const candidate of value.rules) {
    if (
      !isRecord(candidate)
      || !hasOnlyKeys(candidate, ['model', 'stage', 'providers'])
      || !supportedModels.has(candidate.model as ProviderExecutionModel)
      || !supportedStages.has(candidate.stage as ProviderExecutionStage)
      || !Array.isArray(candidate.providers)
    ) {
      throw new TypeError('Provider execution policy rule is invalid');
    }
    const rule = candidate as ProviderExecutionPolicy['rules'][number];
    const target = `${rule.stage}:${rule.model}`;
    if (
      targets.has(target)
      || !supportedTargets.has(target)
      || rule.providers.length === 0
      || rule.providers.some((provider) => !supportedProviders.has(provider))
      || new Set(rule.providers).size !== rule.providers.length
    ) {
      throw new TypeError(`Provider execution policy rule is invalid: ${target}`);
    }
    targets.add(target);
  }
}

function clonePolicy(
  policy: ProviderExecutionPolicy,
): ProviderExecutionPolicy {
  return {
    schemaVersion: 1,
    contract: { ...policy.contract },
    rules: policy.rules.map((rule) => ({
      model: rule.model,
      stage: rule.stage,
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

function throwProviderFailure(
  code: Parameters<typeof failureFor>[0],
  report: ProviderExecutionReport,
  cause?: unknown,
): never {
  throw new ProviderExecutionError(failureFor(code, report), report, cause);
}

function productionModelLoader(
  model: ProviderExecutionModel,
): Promise<ProviderModelMetadata> {
  return getModel(model as ModelName);
}

const productionSessionLoader: ProviderSessionLoader = (model, providers) =>
  getModelSession(model as ModelName, providers);

export function createProviderSessionResolver(
  options: ProviderSessionResolverOptions = {},
): ProviderSessionResolver {
  const policySource = options.policy ?? PRODUCTION_PROVIDER_EXECUTION_POLICY;
  const loadModel = options.loadModel ?? productionModelLoader;
  const loadSession = options.loadSession ?? productionSessionLoader;
  assertPolicy(policySource);
  const policy = clonePolicy(policySource);

  return {
    async execute<T>({
      model,
      stage,
      run,
    }: ProviderExecutionRequest<T>): Promise<ProviderExecutionResult<T>> {
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
      const providers = [...(rule?.providers ?? manifestProviders ?? [])]
        .filter((provider, index, values) =>
          supportedProviders.has(provider) && values.indexOf(provider) === index);
      const attempts: ProviderExecutionAttempt[] = [];

      if (providers.length === 0) {
        const report = createReport(policy, model, stage, attempts);
        throwProviderFailure(
          'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
          report,
        );
      }

      let lastError: unknown;
      let executionFailed = false;
      for (const provider of providers) {
        const attempt = attempts.length + 1;
        let session: WorkerSessionHandle;
        try {
          session = await loadSession(model, [provider]);
        } catch (error) {
          lastError = error;
          attempts.push({
            attempt,
            provider,
            outcome: 'unavailable',
            reason: 'session-unavailable',
          });
          continue;
        }

        if (session.provider !== provider) {
          attempts.push({
            attempt,
            provider,
            outcome: 'failed',
            reason: 'contract-violated',
          });
          const report = createReport(policy, model, stage, attempts);
          throwProviderFailure(
            'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
            report,
          );
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
