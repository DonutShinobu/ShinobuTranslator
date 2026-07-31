import type {
  ProviderExecutionCapability,
  ProviderExecutionModel,
  ProviderExecutionPolicy,
  ProviderExecutionReport,
  ProviderExecutionStage,
  ProviderModelSessionPort,
} from '@shinobu/image-pipeline';
import { isProviderExecutionReport } from '@shinobu/image-pipeline';
import { createProductionProviderExecutionCapability } from '../runtime/productionProviderExecution';
import {
  disposeAllModelSessions,
  getModel,
  getModelSession,
} from '../runtime/modelRegistry';
import type { OnnxSessionOptions } from '../runtime/onnxSessionOptions';

export const WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY:
ProviderExecutionPolicy = Object.freeze({
  schemaVersion: 1,
  contract: Object.freeze({
    id: 'shinobu.webgpu-benchmark-provider-policy',
    version: 1,
  }),
  rules: Object.freeze([
    Object.freeze({
      model: 'detector',
      stage: 'detect',
      providers: Object.freeze(['webgpu'] as const),
    }),
    Object.freeze({
      model: 'bubble',
      stage: 'bubble',
      providers: Object.freeze(['webgpu'] as const),
    }),
    Object.freeze({
      model: 'paddleocr_v6_medium_rec',
      stage: 'ocr',
      providers: Object.freeze(['webgpu'] as const),
    }),
    Object.freeze({
      model: 'inpaint',
      stage: 'inpaint',
      providers: Object.freeze(['webgpu'] as const),
    }),
  ]),
});

export type WebGpuBenchmarkViolationReason =
  | 'missing-provider-report'
  | 'invalid-provider-report'
  | 'contract-mismatch'
  | 'target-not-covered'
  | 'required-provider-mismatch'
  | 'report-unsatisfied'
  | 'non-webgpu-attempt'
  | 'non-recoverable-retry'
  | 'fallback-attempted'
  | 'final-provider-not-webgpu';

export type WebGpuBenchmarkViolation = {
  model?: ProviderExecutionModel;
  stage?: ProviderExecutionStage;
  reason: WebGpuBenchmarkViolationReason;
};

export type WebGpuBenchmarkExecutionVerdict = {
  status: 'satisfied' | 'unsatisfied';
  violations: WebGpuBenchmarkViolation[];
};

export class WebGpuBenchmarkContractError extends Error {
  readonly code = 'PIPELINE_PROVIDER_CONTRACT_VIOLATED';

  constructor(readonly verdict: WebGpuBenchmarkExecutionVerdict) {
    super('pipeline.failure.webGpuBenchmarkContract');
    this.name = 'WebGpuBenchmarkContractError';
  }
}

export function evaluateWebGpuBenchmarkExecution(
  reports: readonly ProviderExecutionReport[],
): WebGpuBenchmarkExecutionVerdict {
  const violations: WebGpuBenchmarkViolation[] = [];
  if (reports.length === 0) {
    violations.push({ reason: 'missing-provider-report' });
  }
  for (const report of reports) {
    if (!isProviderExecutionReport(report)) {
      violations.push({ reason: 'invalid-provider-report' });
      continue;
    }
    const target = {
      model: report.model,
      stage: report.stage,
    };
    if (
      report.contract.id
        !== WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY.contract.id
      || report.contract.version
        !== WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY.contract.version
    ) {
      violations.push({ ...target, reason: 'contract-mismatch' });
    }
    const requiredRule =
      WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY.rules.find((rule) =>
        rule.model === report.model && rule.stage === report.stage);
    if (!requiredRule) {
      violations.push({ ...target, reason: 'target-not-covered' });
    }
    if (
      report.requiredProviders.length !== 1
      || report.requiredProviders[0] !== 'webgpu'
    ) {
      violations.push({ ...target, reason: 'required-provider-mismatch' });
    }
    if (!report.satisfied) {
      violations.push({ ...target, reason: 'report-unsatisfied' });
    }
    if (report.attempts.some((attempt) => attempt.provider !== 'webgpu')) {
      violations.push({ ...target, reason: 'non-webgpu-attempt' });
    }
    if (report.attempts.slice(0, -1).some((attempt) =>
      attempt.outcome !== 'failed' || attempt.reason !== 'session-lost')) {
      violations.push({ ...target, reason: 'non-recoverable-retry' });
    }
    if (report.fallbackTrace.length > 0) {
      violations.push({ ...target, reason: 'fallback-attempted' });
    }
    if (report.finalProvider !== 'webgpu') {
      violations.push({ ...target, reason: 'final-provider-not-webgpu' });
    }
  }
  return {
    status: violations.length === 0 ? 'satisfied' : 'unsatisfied',
    violations,
  };
}

export function assertWebGpuBenchmarkExecution(
  reports: readonly ProviderExecutionReport[],
): void {
  const verdict = evaluateWebGpuBenchmarkExecution(reports);
  if (verdict.status === 'unsatisfied') {
    throw new WebGpuBenchmarkContractError(verdict);
  }
}

export type BenchmarkProviderExecutionInput = {
  policy: ProviderExecutionPolicy;
  modelSession?: ProviderModelSessionPort;
  sessionOptionsByModel?: Partial<
    Record<ProviderExecutionModel, OnnxSessionOptions>
  >;
};

export function resolveBenchmarkProviderExecutionCapability(
  input?: BenchmarkProviderExecutionInput,
): ProviderExecutionCapability {
  if (input?.modelSession) {
    return {
      policy: input.policy,
      modelSession: input.modelSession,
    };
  }
  if (input?.sessionOptionsByModel) {
    return {
      policy: input.policy,
      modelSession: {
        loadModel: (model) => getModel(model),
        loadSession: (model, provider) => getModelSession(
          model,
          provider,
          input.sessionOptionsByModel?.[model],
        ),
        resetRuntime: () => disposeAllModelSessions(),
      },
    };
  }
  return createProductionProviderExecutionCapability(
    input?.policy ?? WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY,
  );
}
