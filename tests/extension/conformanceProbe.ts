import {
  successfulConformanceScenario,
} from '../../apps/extension/conformance/scenarios';
import type {
  ConformanceBrowser,
  ConformanceHost,
  ConformanceObservation,
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
};

function targetMetadata(): TargetMetadata {
  const element = document.querySelector<HTMLMetaElement>(
    'meta[name="shinobu-conformance-target"]',
  );
  if (!element) throw new Error('Conformance build target metadata is missing');
  const [browser, host] = element.content.split(':');
  if (
    (browser !== 'chrome' && browser !== 'firefox')
    || (host !== 'broker-offscreen' && host !== 'event-page-direct')
  ) {
    throw new Error(`Invalid conformance build target: ${element.content}`);
  }
  return { browser, host };
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
    ...target,
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

async function main(): Promise<void> {
  try {
    const observation = await runProbe();
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
