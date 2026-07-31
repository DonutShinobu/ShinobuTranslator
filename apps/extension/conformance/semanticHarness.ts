import {
  isProviderExecutionReport,
} from '@shinobu/image-pipeline';
import type {
  NormalizedSemanticTraceExecution,
  NormalizedSemanticTraceObservation,
  SemanticTraceExecutionObservation,
  SemanticTraceObservation,
} from './types';

function assertCommonExecutionContract(
  execution: SemanticTraceExecutionObservation,
): void {
  if (execution.finalizationCount !== 1) {
    throw new TypeError('semantic execution must finalize exactly once');
  }
  if (execution.resourceSettlementCount !== 1) {
    throw new TypeError('semantic execution must settle resources exactly once');
  }
  if (execution.publicEventsAfterTerminal !== 0) {
    throw new TypeError('semantic execution emitted a public event after terminal');
  }
  if (!execution.barriers.includes('runtime-resources-settled')) {
    throw new TypeError('semantic execution omitted the resource settlement barrier');
  }
  const terminalCount = Number(execution.result !== null)
    + Number(execution.failure !== null)
    + Number(execution.cancellation !== null);
  if (terminalCount !== 1) {
    throw new TypeError('semantic execution must have exactly one terminal');
  }
}

function assertDetectorFailure(
  execution: SemanticTraceExecutionObservation,
): void {
  const failure = execution.failure;
  if (
    !failure
    || failure.code !== 'PIPELINE_PROVIDER_EXECUTION_FAILED'
    || failure.stage !== 'detect'
    || failure.scope !== 'runtime'
    || failure.retryable
    || execution.resultProducedCount !== 0
    || execution.commitCount !== 0
    || !execution.barriers.includes('detector-webgpu-inference-failed')
  ) {
    throw new TypeError('invalid detector WebGPU failure trace');
  }
  const report = failure.diagnostics?.report;
  if (
    !isProviderExecutionReport(report)
    || report.model !== 'detector'
    || report.stage !== 'detect'
    || report.requiredProviders.length !== 1
    || report.requiredProviders[0] !== 'webgpu'
    || report.attempts.length < 2
    || report.attempts.some((attempt) =>
      attempt.provider !== 'webgpu'
      || attempt.outcome !== 'failed'
      || attempt.reason !== 'session-lost')
    || report.fallbackTrace.length !== 0
    || report.satisfied
    || report.finalProvider !== undefined
  ) {
    throw new TypeError('detector failure must exhaust WebGPU without fallback');
  }
  const forbiddenStages = new Set([
    'bubble',
    'ocr',
    'merge',
    'parallel',
    'translate',
    'inpaint',
    'typeset',
    'finalize',
    'done',
  ]);
  if (execution.progress.some((event) => forbiddenStages.has(event.stage))) {
    throw new TypeError('detector failure trace continued to a later stage');
  }
}

function assertTranslationFailure(
  execution: SemanticTraceExecutionObservation,
): void {
  const failure = execution.failure;
  const diagnostics = failure?.diagnostics;
  const expectedBarriers = [
    'translation-network-attempt-1',
    'translation-network-attempt-2',
    'translation-network-attempt-3',
  ];
  const networkBarriers = execution.barriers.filter((barrier) =>
    barrier.startsWith('translation-network-attempt-'));
  const retryProgress = execution.progress.filter((event) =>
    event.stage === 'translate'
    && event.operation === 'translate-plain'
    && event.retry !== undefined);
  if (
    !failure
    || failure.code !== 'PIPELINE_OPERATION_RETRIES_EXHAUSTED'
    || failure.stage !== 'translate'
    || failure.scope !== 'runtime'
    || failure.retryable
    || diagnostics?.operation !== 'translate-plain'
    || diagnostics.attempts !== 3
    || expectedBarriers.some((barrier, index) =>
      networkBarriers[index] !== barrier)
    || networkBarriers.length !== expectedBarriers.length
    || retryProgress.length !== 2
    || retryProgress[0]?.retry?.attempt !== 2
    || retryProgress[1]?.retry?.attempt !== 3
    || retryProgress.some((event) => event.retry?.maxAttempts !== 3)
    || execution.resultProducedCount !== 0
    || execution.commitCount !== 0
  ) {
    throw new TypeError(
      'translation failure trace must record exactly three operation attempts',
    );
  }
}

function assertParallelCancellation(
  execution: SemanticTraceExecutionObservation,
): void {
  if (
    execution.failure !== null
    || execution.result !== null
    || execution.cancellation?.code !== 'TASK_CANCELLED'
    || execution.cancellation.reason.code !== 'user-requested'
    || !execution.barriers.includes('parallel-translate-inpaint-started')
    || !execution.progress.some((event) => event.stage === 'parallel')
    || execution.resultProducedCount !== 0
    || execution.commitCount !== 0
  ) {
    throw new TypeError(
      'parallel cancellation must settle as TASK_CANCELLED/user-requested',
    );
  }
}

function normalizeExecution(
  execution: SemanticTraceExecutionObservation,
): NormalizedSemanticTraceExecution {
  assertCommonExecutionContract(execution);
  const {
    result,
    failure,
    cancellation,
    ...observation
  } = structuredClone(execution);
  const canonicalObservation = {
    ...observation,
    progress: observation.progress.map(({ detail: _detail, ...event }) => event),
  };
  if (failure) {
    const canonicalFailure = failure.code === 'PIPELINE_PROVIDER_EXECUTION_FAILED'
      ? {
          ...failure,
          diagnostics: {
            contract: failure.diagnostics?.contract,
            model: failure.diagnostics?.model,
            report: failure.diagnostics?.report,
          },
        }
      : failure.code === 'PIPELINE_OPERATION_RETRIES_EXHAUSTED'
        ? {
            ...failure,
            diagnostics: {
              operation: failure.diagnostics?.operation,
              attempts: failure.diagnostics?.attempts,
            },
          }
        : failure;
    return {
      ...canonicalObservation,
      terminal: { kind: 'failure', failure: canonicalFailure },
    };
  }
  if (cancellation) {
    const { diagnosticSummary: _diagnosticSummary, ...canonicalReason } =
      cancellation.reason;
    return {
      ...canonicalObservation,
      terminal: {
        kind: 'cancelled',
        code: cancellation.code,
        reason: canonicalReason,
      },
    };
  }
  return {
    ...canonicalObservation,
    terminal: {
      kind: 'completed',
      status: result!.status,
    },
  };
}

function assertDisconnectRecovery(
  observation: SemanticTraceObservation,
): void {
  const [disconnected, recovered] = observation.executions;
  if (
    observation.hostRebuildCount !== 1
    || observation.executions.length !== 2
    || !disconnected
    || disconnected.ordinal !== 1
    || disconnected.result !== null
    || disconnected.failure !== null
    || disconnected.cancellation?.code !== 'TASK_CANCELLED'
    || disconnected.cancellation.reason.code !== 'transport-disconnected'
    || disconnected.resultProducedCount !== 1
    || disconnected.commitCount !== 0
    || !disconnected.barriers.includes('runtime-result-produced')
    || !disconnected.barriers.includes('runtime-resources-settled')
    || !disconnected.barriers.includes('host-disconnected-before-commit')
    || !recovered
    || recovered.ordinal !== 2
    || recovered.result?.status !== 'completed'
    || recovered.failure !== null
    || recovered.cancellation !== null
    || recovered.resultProducedCount !== 1
    || recovered.commitCount !== 1
    || !recovered.barriers.includes('host-rebuilt')
    || !recovered.barriers.includes('runtime-result-produced')
    || !recovered.barriers.includes('runtime-resources-settled')
  ) {
    throw new TypeError(
      'host disconnect recovery must rebuild exactly once before success',
    );
  }
}

export function normalizeSemanticTraceObservation(
  observation: SemanticTraceObservation,
): NormalizedSemanticTraceObservation {
  if (observation.schemaVersion !== 1) {
    throw new TypeError('unsupported semantic trace observation schema');
  }
  if (observation.executions.length === 0) {
    throw new TypeError('semantic trace observation requires an execution');
  }
  if (observation.scenarioId === 'detector-webgpu-failure-v1') {
    if (observation.executions.length !== 1) {
      throw new TypeError('detector failure trace requires one execution');
    }
    assertDetectorFailure(observation.executions[0]!);
  }
  if (observation.scenarioId === 'translation-retry-exhaustion-v1') {
    if (observation.executions.length !== 1) {
      throw new TypeError('translation failure trace requires one execution');
    }
    assertTranslationFailure(observation.executions[0]!);
  }
  if (observation.scenarioId === 'parallel-user-cancellation-v1') {
    if (observation.executions.length !== 1) {
      throw new TypeError('parallel cancellation trace requires one execution');
    }
    assertParallelCancellation(observation.executions[0]!);
  }
  if (observation.scenarioId === 'host-disconnect-recovery-v1') {
    assertDisconnectRecovery(observation);
  }
  return {
    schemaVersion: 1,
    scenarioId: observation.scenarioId,
    hostRebuildCount: observation.hostRebuildCount,
    executions: observation.executions.map(normalizeExecution),
  };
}

export function compareSemanticTraceObservations(
  chrome: NormalizedSemanticTraceObservation,
  firefox: NormalizedSemanticTraceObservation,
): { matches: true } {
  if (JSON.stringify(chrome) !== JSON.stringify(firefox)) {
    throw new TypeError('Chrome and Firefox semantic traces differ');
  }
  return { matches: true };
}
