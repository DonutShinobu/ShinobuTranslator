import { describe, expect, it } from 'vitest';
import {
  compareSemanticTraceObservations,
  normalizeSemanticTraceObservation,
} from '../../apps/extension/conformance/semanticHarness';
import type {
  SemanticTraceObservation,
} from '../../apps/extension/conformance/types';

function detectorFailureObservation(
  browser: 'chrome' | 'firefox',
): SemanticTraceObservation {
  return {
    schemaVersion: 1,
    browser,
    host: browser === 'chrome'
      ? 'broker-offscreen'
      : 'event-page-direct',
    scenarioId: 'detector-webgpu-failure-v1',
    hostRebuildCount: 0,
    executions: [{
      ordinal: 1,
      barriers: [
        'detector-webgpu-inference-failed',
        'runtime-resources-settled',
      ],
      progress: [
        { stage: 'runtime-prepare', operation: 'runtime-prepare' },
        { stage: 'load', operation: 'load' },
        { stage: 'preload', operation: 'preload' },
        { stage: 'detect', operation: 'detect' },
      ],
      resultProducedCount: 0,
      result: null,
      failure: {
        code: 'PIPELINE_PROVIDER_EXECUTION_FAILED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.providerExecution',
        diagnostics: {
          contract: {
            id: 'shinobu.webgpu-benchmark-provider-policy',
            version: 1,
          },
          model: 'detector',
          report: {
            schemaVersion: 1,
            contract: {
              id: 'shinobu.webgpu-benchmark-provider-policy',
              version: 1,
            },
            model: 'detector',
            stage: 'detect',
            requiredProviders: ['webgpu'],
            attempts: [1, 2, 3].map((attempt) => ({
              attempt,
              provider: 'webgpu' as const,
              outcome: 'failed' as const,
              reason: 'session-lost' as const,
            })),
            fallbackTrace: [],
            satisfied: false,
          },
        },
      },
      cancellation: null,
      finalizationCount: 1,
      resourceSettlementCount: 1,
      commitCount: 0,
      publicEventsAfterTerminal: 0,
    }],
  };
}

function translationFailureObservation(
  browser: 'chrome' | 'firefox',
): SemanticTraceObservation {
  return {
    schemaVersion: 1,
    browser,
    host: browser === 'chrome'
      ? 'broker-offscreen'
      : 'event-page-direct',
    scenarioId: 'translation-retry-exhaustion-v1',
    hostRebuildCount: 0,
    executions: [{
      ordinal: 1,
      barriers: [
        'translation-network-attempt-1',
        'translation-network-attempt-2',
        'translation-network-attempt-3',
        'runtime-resources-settled',
      ],
      progress: [
        {
          stage: 'translate',
          operation: 'translate-plain',
          retry: { attempt: 2, maxAttempts: 3, delayMs: 1 },
        },
        {
          stage: 'translate',
          operation: 'translate-plain',
          retry: { attempt: 3, maxAttempts: 3, delayMs: 1 },
        },
      ],
      resultProducedCount: 0,
      result: null,
      failure: {
        code: 'PIPELINE_OPERATION_RETRIES_EXHAUSTED',
        stage: 'translate',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.translationUnavailable',
        diagnostics: {
          operation: 'translate-plain',
          attempts: 3,
        },
      },
      cancellation: null,
      finalizationCount: 1,
      resourceSettlementCount: 1,
      commitCount: 0,
      publicEventsAfterTerminal: 0,
    }],
  };
}

function cancellationObservation(
  browser: 'chrome' | 'firefox',
): SemanticTraceObservation {
  return {
    schemaVersion: 1,
    browser,
    host: browser === 'chrome'
      ? 'broker-offscreen'
      : 'event-page-direct',
    scenarioId: 'parallel-user-cancellation-v1',
    hostRebuildCount: 0,
    executions: [{
      ordinal: 1,
      barriers: [
        'parallel-translate-inpaint-started',
        'runtime-resources-settled',
      ],
      progress: [{ stage: 'parallel', operation: 'parallel' }],
      resultProducedCount: 0,
      result: null,
      failure: null,
      cancellation: {
        code: 'TASK_CANCELLED',
        reason: {
          code: 'user-requested',
          messageKey: 'pipeline.cancelled.userRequested',
        },
      },
      finalizationCount: 1,
      resourceSettlementCount: 1,
      commitCount: 0,
      publicEventsAfterTerminal: 0,
    }],
  };
}

function disconnectRecoveryObservation(
  browser: 'chrome' | 'firefox',
): SemanticTraceObservation {
  const completedResult = {
    status: 'completed' as const,
    artifact: {
      contentType: 'image/png',
      width: 120,
      height: 80,
      byteLength: 400,
      nativeBytesSha256: 'native-sha256',
    },
    record: {
      schemaVersion: 2 as const,
      workingCopy: {
        width: 120,
        height: 80,
        spec: { strategy: 'source-native' as const },
        sourceToWorkingCopy: { kind: 'identity' as const },
      },
      ocr: [],
      translations: [],
    },
    providerReports: [],
  };
  return {
    schemaVersion: 1,
    browser,
    host: browser === 'chrome'
      ? 'broker-offscreen'
      : 'event-page-direct',
    scenarioId: 'host-disconnect-recovery-v1',
    hostRebuildCount: 1,
    executions: [
      {
        ordinal: 1,
        barriers: [
          'runtime-result-produced',
          'runtime-resources-settled',
          'host-disconnected-before-commit',
        ],
        progress: [{ stage: 'done', operation: 'done' }],
        resultProducedCount: 1,
        result: null,
        failure: null,
        cancellation: {
          code: 'TASK_CANCELLED',
          reason: {
            code: 'transport-disconnected',
            messageKey: 'pipeline.cancelled.transportDisconnected',
          },
        },
        finalizationCount: 1,
        resourceSettlementCount: 1,
        commitCount: 0,
        publicEventsAfterTerminal: 0,
      },
      {
        ordinal: 2,
        barriers: [
          'host-rebuilt',
          'runtime-result-produced',
          'runtime-resources-settled',
        ],
        progress: [
          { stage: 'finalize', operation: 'freeze-result' },
          { stage: 'done', operation: 'done' },
        ],
        resultProducedCount: 1,
        result: completedResult,
        failure: null,
        cancellation: null,
        finalizationCount: 1,
        resourceSettlementCount: 1,
        commitCount: 1,
        publicEventsAfterTerminal: 0,
      },
    ],
  };
}

describe('failure, cancellation, disconnect, and recovery semantic trace gate', () => {
  it('accepts a detector WebGPU execution failure without fallback or later stages', () => {
    const normalized = normalizeSemanticTraceObservation(
      detectorFailureObservation('chrome'),
    );

    expect(normalized.executions[0]).toMatchObject({
      barriers: [
        'detector-webgpu-inference-failed',
        'runtime-resources-settled',
      ],
      terminal: {
        kind: 'failure',
        failure: {
          code: 'PIPELINE_PROVIDER_EXECUTION_FAILED',
          stage: 'detect',
        },
      },
      resultProducedCount: 0,
      finalizationCount: 1,
      resourceSettlementCount: 1,
      commitCount: 0,
    });
    expect(normalized.executions[0]?.progress.map((event) => event.stage))
      .not.toContain('bubble');
  });

  it('accepts exactly three retryable translation network attempts as a runtime failure', () => {
    const normalized = normalizeSemanticTraceObservation(
      translationFailureObservation('firefox'),
    );

    expect(normalized.executions[0]).toMatchObject({
      terminal: {
        kind: 'failure',
        failure: {
          code: 'PIPELINE_OPERATION_RETRIES_EXHAUSTED',
          stage: 'translate',
          scope: 'runtime',
          diagnostics: {
            operation: 'translate-plain',
            attempts: 3,
          },
        },
      },
      commitCount: 0,
    });
  });

  it('rejects translation retry traces with the wrong operation attempt count', () => {
    const invalid = translationFailureObservation('chrome');
    (invalid.executions[0]!.failure as {
      diagnostics: Record<string, unknown>;
    }).diagnostics.attempts = 2;

    expect(() => normalizeSemanticTraceObservation(invalid)).toThrow(
      /translation.*three.*attempts/iu,
    );
  });

  it('keeps parallel user cancellation out of the failure envelope', () => {
    const normalized = normalizeSemanticTraceObservation(
      cancellationObservation('chrome'),
    );

    expect(normalized.executions[0]?.terminal).toEqual({
      kind: 'cancelled',
      code: 'TASK_CANCELLED',
      reason: {
        code: 'user-requested',
        messageKey: 'pipeline.cancelled.userRequested',
      },
    });
  });

  it('rejects a parallel cancellation trace reclassified as transport loss', () => {
    const invalid = cancellationObservation('firefox');
    invalid.executions[0]!.cancellation!.reason.code =
      'transport-disconnected';

    expect(() => normalizeSemanticTraceObservation(invalid)).toThrow(
      /parallel.*user-requested/iu,
    );
  });

  it('drops a pre-commit host result and succeeds after rebuilding the real host', () => {
    const chromeObservation = disconnectRecoveryObservation('chrome');
    chromeObservation.executions[0]!.cancellation!.reason.diagnosticSummary =
      'pipeline host channel 已断开';
    chromeObservation.executions[0]!.progress[0]!.detail =
      'Chrome transport detail';
    const firefoxObservation = disconnectRecoveryObservation('firefox');
    firefoxObservation.executions[0]!.cancellation!.reason.diagnosticSummary =
      '本地流水线 channel 已断开（peer-disconnected）';
    firefoxObservation.executions[0]!.progress[0]!.detail =
      'Firefox transport detail';
    const chrome = normalizeSemanticTraceObservation(
      chromeObservation,
    );
    const firefox = normalizeSemanticTraceObservation(
      firefoxObservation,
    );

    expect(chrome.executions.map((execution) => ({
      terminal: execution.terminal.kind,
      resultProducedCount: execution.resultProducedCount,
      commitCount: execution.commitCount,
      resourceSettlementCount: execution.resourceSettlementCount,
    }))).toEqual([
      {
        terminal: 'cancelled',
        resultProducedCount: 1,
        commitCount: 0,
        resourceSettlementCount: 1,
      },
      {
        terminal: 'completed',
        resultProducedCount: 1,
        commitCount: 1,
        resourceSettlementCount: 1,
      },
    ]);
    expect(compareSemanticTraceObservations(chrome, firefox)).toEqual({
      matches: true,
    });
  });

  it('rejects disconnect recovery without exactly one real-host rebuild', () => {
    const invalid = disconnectRecoveryObservation('chrome');
    invalid.hostRebuildCount = 0;

    expect(() => normalizeSemanticTraceObservation(invalid)).toThrow(
      /host.*rebuild.*exactly once/iu,
    );
  });
});
