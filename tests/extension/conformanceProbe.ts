import {
  successfulConformanceScenario,
} from '../../apps/extension/conformance/scenarios';
import type {
  ConformanceBrowser,
  ConformanceHost,
  ConformanceObservation,
  ConformanceResultObservation,
  SemanticTraceExecutionObservation,
  SemanticTraceObservation,
} from '../../apps/extension/conformance/types';
import {
  createTargetExtensionAdapter,
} from '../../apps/extension/src/capabilities/targetAdapter';
import {
  createRunLocalPipeline,
} from '../../src/content/core/translation/localPipelineClient';

type TargetMetadata = {
  browser: ConformanceBrowser;
  host: ConformanceHost;
  profile:
    | 'success'
    | 'detector-failure'
    | 'translation-failure'
    | 'lifecycle';
};

function targetMetadata(): TargetMetadata {
  const element = document.querySelector<HTMLMetaElement>(
    'meta[name="shinobu-conformance-target"]',
  );
  if (!element) throw new Error('Conformance build target metadata is missing');
  const [browser, host, profile = 'success'] = element.content.split(':');
  if (
    (browser !== 'chrome' && browser !== 'firefox')
    || (host !== 'broker-offscreen' && host !== 'event-page-direct')
    || ![
      'success',
      'detector-failure',
      'translation-failure',
      'lifecycle',
    ].includes(profile)
  ) {
    throw new Error(`Invalid conformance build target: ${element.content}`);
  }
  return {
    browser,
    host,
    profile: profile as TargetMetadata['profile'],
  };
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256(blob: Blob): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
}

async function fetchResource(path: string): Promise<Blob> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Could not load conformance resource ${path}: ${response.status}`);
  }
  return await response.blob();
}

async function imageSize(blob: Blob): Promise<{
  width: number;
  height: number;
}> {
  const bitmap = await createImageBitmap(blob);
  try {
    return {
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

async function runProbe(): Promise<ConformanceObservation> {
  const target = targetMetadata();
  const scenario = successfulConformanceScenario();
  const input = await fetchResource(scenario.input.path);
  const resourceEntries = await Promise.all(
    Object.entries(scenario.resourcePaths).map(async ([name, path]) => [
      name,
      await sha256(await fetchResource(path)),
    ]),
  );
  const resourceDigests = Object.fromEntries(resourceEntries) as {
    font: string;
    modelManifest: string;
    modelChecksums: string;
  };
  const progress: ConformanceObservation['progress'] = [];
  const runLocalPipeline = createRunLocalPipeline(
    createTargetExtensionAdapter().content().runtimeChannels,
  );
  const result = await runLocalPipeline(
    new File([input], scenario.input.path, {
      type: scenario.input.contentType,
      lastModified: 0,
    }),
    {
      ...scenario.config,
      llmApiKey: '',
    },
    (event) => {
      if (!event.operation) {
        throw new Error(
          `Pipeline progress omitted operation for ${event.stage}`,
        );
      }
      progress.push(structuredClone({
        ...event,
        operation: event.operation,
      }));
      document.body.textContent = JSON.stringify({
        progressCount: progress.length,
        lastProgress: progress.at(-1),
      });
    },
  );
  const dimensions = await imageSize(result.result);

  return {
    schemaVersion: 1,
    browser: target.browser,
    host: target.host,
    scenarioId: scenario.id,
    request: {
      inputSha256: await sha256(input),
      config: structuredClone(scenario.config),
      workingCopy: structuredClone(scenario.workingCopy),
      fixedTranslationResponse: scenario.fixedTranslationResponse,
      providerContract: structuredClone(scenario.providerPolicy.contract),
      resourceDigests,
    },
    progress,
    result: {
      status: result.status,
      artifact: {
        contentType: result.result.type,
        ...dimensions,
        byteLength: result.result.size,
        nativeBytesSha256: await sha256(result.result),
      },
      record: result.record,
      providerReports: result.providerReports,
    },
    failure: null,
    cancellation: null,
    finalizationCount: progress.filter(
      (event) => event.stage === 'finalize',
    ).length,
    commitCount: 1,
  };
}

function normalizedProgress(
  progress: {
    stage: string;
    operation?: string;
    detail: string;
    completed?: number;
    total?: number;
    retry?: {
      attempt: number;
      maxAttempts: number;
      delayMs: number;
    };
  },
) {
  return {
    stage: progress.stage,
    operation: progress.operation ?? progress.stage,
    ...(progress.detail === undefined ? {} : { detail: progress.detail }),
    ...(progress.completed === undefined
      ? {}
      : { completed: progress.completed }),
    ...(progress.total === undefined ? {} : { total: progress.total }),
    ...(progress.retry === undefined
      ? {}
      : { retry: structuredClone(progress.retry) }),
  };
}

function cancellationFrom(error: unknown) {
  if (
    !error
    || typeof error !== 'object'
    || !('code' in error)
    || error.code !== 'TASK_CANCELLED'
    || !('cancellationReason' in error)
    || !error.cancellationReason
    || typeof error.cancellationReason !== 'object'
  ) return null;
  return {
    code: 'TASK_CANCELLED' as const,
    reason: structuredClone(error.cancellationReason),
  } as SemanticTraceExecutionObservation['cancellation'];
}

function failureFrom(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const candidate = error as Record<string, unknown>;
  if (
    typeof candidate.code !== 'string'
    || typeof candidate.scope !== 'string'
    || typeof candidate.retryable !== 'boolean'
    || typeof candidate.messageKey !== 'string'
  ) return null;
  return {
    code: candidate.code,
    ...(typeof candidate.stage === 'string'
      ? { stage: candidate.stage }
      : {}),
    scope: candidate.scope,
    retryable: candidate.retryable,
    messageKey: candidate.messageKey,
    ...(candidate.diagnostics
      ? { diagnostics: structuredClone(candidate.diagnostics) }
      : {}),
  } as SemanticTraceExecutionObservation['failure'];
}

async function resultObservation(
  result: Awaited<ReturnType<ReturnType<typeof createRunLocalPipeline>>>,
): Promise<ConformanceResultObservation> {
  return {
    status: result.status,
    artifact: {
      contentType: result.result.type,
      ...await imageSize(result.result),
      byteLength: result.result.size,
      nativeBytesSha256: await sha256(result.result),
    },
    record: result.record,
    providerReports: result.providerReports,
  };
}

async function runSemanticExecution(options: {
  ordinal: number;
  cancelAtParallel?: boolean;
}): Promise<SemanticTraceExecutionObservation> {
  const scenario = successfulConformanceScenario();
  const input = await fetchResource(scenario.input.path);
  const controller = new AbortController();
  const barriers: string[] = [];
  const progress: SemanticTraceExecutionObservation['progress'] = [];
  let publicEventsAfterTerminal = 0;
  let settledObservation: SemanticTraceExecutionObservation | undefined;
  let terminal = false;
  const runLocalPipeline = createRunLocalPipeline(
    createTargetExtensionAdapter().content().runtimeChannels,
  );
  let result: ConformanceResultObservation | null = null;
  let failure: SemanticTraceExecutionObservation['failure'] = null;
  let cancellation: SemanticTraceExecutionObservation['cancellation'] = null;
  let resultProducedCount = 0;
  let commitCount = 0;
  let finalizationCount = 0;
  let resourceSettlementCount = 0;
  try {
    const pipelineResult = await runLocalPipeline(
      new File([input], scenario.input.path, {
        type: scenario.input.contentType,
        lastModified: 0,
      }),
      { ...scenario.config, llmApiKey: '' },
      (event) => {
        if (terminal) {
          publicEventsAfterTerminal += 1;
          if (settledObservation) {
            settledObservation.publicEventsAfterTerminal =
              publicEventsAfterTerminal;
          }
          return;
        }
        if (
          event.stage === 'semantic-trace'
          && event.operation
        ) {
          if (event.operation === 'execution-finalized') {
            finalizationCount += 1;
          } else if (event.operation === 'runtime-resources-settled') {
            resourceSettlementCount += 1;
            barriers.push(event.operation);
          } else {
            barriers.push(event.operation);
          }
          if (event.operation === 'runtime-result-produced') {
            resultProducedCount = 1;
            document.body.dataset.barrier = event.operation;
          }
          return;
        }
        progress.push(normalizedProgress(event));
        if (
          options.cancelAtParallel
          && event.stage === 'parallel'
          && event.operation === 'parallel-translate-inpaint-running'
          && !controller.signal.aborted
        ) {
          barriers.push('parallel-translate-inpaint-started');
          controller.abort({
            code: 'user-requested',
            messageKey: 'pipeline.cancelled.userRequested',
          });
        }
      },
      { signal: controller.signal },
    );
    resultProducedCount = 1;
    barriers.push('runtime-result-produced');
    result = await resultObservation(pipelineResult);
    commitCount = 1;
  } catch (error) {
    cancellation = cancellationFrom(error);
    failure = cancellation ? null : failureFrom(error);
    if (cancellation?.reason.code === 'transport-disconnected') {
      barriers.push('host-disconnected-before-commit');
    }
    if (!cancellation && !failure) throw error;
  } finally {
    terminal = true;
  }
  settledObservation = {
    ordinal: options.ordinal,
    barriers,
    progress,
    resultProducedCount,
    result,
    failure,
    cancellation,
    finalizationCount,
    resourceSettlementCount,
    commitCount,
    publicEventsAfterTerminal,
  };
  return settledObservation;
}

async function passPublicEventQuiescenceBarrier(): Promise<void> {
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

async function runSemanticProbe(): Promise<SemanticTraceObservation[]> {
  const target = targetMetadata();
  if (target.profile === 'detector-failure') {
    const execution = await runSemanticExecution({ ordinal: 1 });
    await passPublicEventQuiescenceBarrier();
    return [{
      schemaVersion: 1,
      browser: target.browser,
      host: target.host,
      scenarioId: 'detector-webgpu-failure-v1',
      hostRebuildCount: 0,
      executions: [execution],
    }];
  }
  if (target.profile === 'translation-failure') {
    const execution = await runSemanticExecution({ ordinal: 1 });
    await passPublicEventQuiescenceBarrier();
    return [{
      schemaVersion: 1,
      browser: target.browser,
      host: target.host,
      scenarioId: 'translation-retry-exhaustion-v1',
      hostRebuildCount: 0,
      executions: [execution],
    }];
  }
  const cancellation = await runSemanticExecution({
    ordinal: 1,
    cancelAtParallel: true,
  });
  const disconnected = await runSemanticExecution({ ordinal: 1 });
  document.body.dataset.barrier = 'waiting-for-host-rebuild';
  const recovered = await runSemanticExecution({ ordinal: 2 });
  await passPublicEventQuiescenceBarrier();
  return [
    {
      schemaVersion: 1,
      browser: target.browser,
      host: target.host,
      scenarioId: 'parallel-user-cancellation-v1',
      hostRebuildCount: 0,
      executions: [cancellation],
    },
    {
      schemaVersion: 1,
      browser: target.browser,
      host: target.host,
      scenarioId: 'host-disconnect-recovery-v1',
      hostRebuildCount: 0,
      executions: [disconnected, recovered],
    },
  ];
}

async function main(): Promise<void> {
  try {
    const observation = targetMetadata().profile === 'success'
      ? await runProbe()
      : await runSemanticProbe();
    document.body.textContent = JSON.stringify(observation);
    document.body.dataset.state = 'complete';
  } catch (error) {
    document.body.textContent = JSON.stringify({
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    document.body.dataset.state = 'error';
  }
}

void main();
