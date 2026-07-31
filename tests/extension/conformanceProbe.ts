import {
  GOLDEN_CONFORMANCE_MATRIX,
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
import type {
  LocalPipelineArtifactSummary,
} from '../../src/shared/localPipelineProtocol';

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

function rgbaToBase64(data: Uint8ClampedArray): string {
  const chunks: string[] = [];
  const chunkSize = 32_768;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...data.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

async function decodeRgba(blob: Blob): Promise<{
  width: number;
  height: number;
  data: Uint8ClampedArray;
}> {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'default',
    premultiplyAlpha: 'none',
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', {
      alpha: true,
      colorSpace: 'srgb',
      willReadFrequently: true,
    });
    if (!context) throw new Error('Could not create conformance RGBA decoder');
    context.clearRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      data: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
    };
  } finally {
    bitmap.close();
  }
}

function sameRgba(
  left: Awaited<ReturnType<typeof decodeRgba>>,
  right: Awaited<ReturnType<typeof decodeRgba>>,
): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.data.length === right.data.length
    && left.data.every((value, index) => value === right.data[index]);
}

function collectNumericLeaves(
  target: Record<string, number>,
  path: string,
  value: unknown,
): void {
  if (typeof value === 'number') {
    target[path] = value;
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      collectNumericLeaves(target, `${path}[${index}]`, child);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    collectNumericLeaves(target, `${path}.${key}`, child);
  }
}

function typesetMetrics(
  summary: Pick<LocalPipelineArtifactSummary, 'typesetDebug'>,
): NonNullable<ConformanceObservation['result']>['typesetMetrics'] {
  const font: Record<string, number> = {};
  const layout: Record<string, number> = {};
  const debug = summary.typesetDebug;
  if (!debug || typeof debug !== 'object' || !('regions' in debug)) {
    return { font, layout };
  }
  const regions = (debug as { regions?: unknown }).regions;
  if (!Array.isArray(regions)) return { font, layout };
  for (const [index, region] of regions.entries()) {
    if (!region || typeof region !== 'object') continue;
    const record = region as Record<string, unknown>;
    if (typeof record.initialFontSize === 'number') {
      font[`typeset[${index}].initialFontSize`] = record.initialFontSize;
    }
    if (typeof record.fittedFontSize === 'number') {
      font[`typeset[${index}].fittedFontSize`] = record.fittedFontSize;
    }
    for (const field of [
      'sourceBox',
      'expandedBox',
      'sourceQuad',
      'expandedQuad',
      'offscreenWidth',
      'offscreenHeight',
      'boxPadding',
      'strokePadding',
      'layoutDiagnostics',
      'columnBoxes',
      'columnCanvasQuads',
      'columnGlyphCenters',
      'columnVerticalItems',
    ]) {
      collectNumericLeaves(
        layout,
        `typeset[${index}].${field}`,
        record[field],
      );
    }
  }
  return { font, layout };
}

async function runProbe(
  scenario: (typeof GOLDEN_CONFORMANCE_MATRIX)[number],
): Promise<ConformanceObservation> {
  const target = targetMetadata();
  const input = await fetchResource(scenario.input.path);
  const inputSha256 = await sha256(input);
  if (inputSha256 !== scenario.input.sha256) {
    throw new Error(`Conformance input hash mismatch for ${scenario.id}`);
  }
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
  const [inputRgba, resultRgba] = await Promise.all([
    decodeRgba(input),
    decodeRgba(result.result),
  ]);

  return {
    schemaVersion: 1,
    ...target,
    scenarioId: scenario.id,
    request: {
      inputSha256,
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
        channelOrder: 'rgba',
        colorSpace: 'srgb',
        decodedRgbaBase64: rgbaToBase64(resultRgba.data),
        inputEquivalentToSource: sameRgba(inputRgba, resultRgba),
        byteLength: result.result.size,
        nativeBytesSha256: await sha256(result.result),
      },
      record: result.record,
      typesetMetrics: typesetMetrics(result.summary),
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
    const observations: ConformanceObservation[] = [];
    for (const scenario of GOLDEN_CONFORMANCE_MATRIX) {
      document.body.textContent = JSON.stringify({
        completedScenarios: observations.map((entry) => entry.scenarioId),
        runningScenario: scenario.id,
      });
      observations.push(await runProbe(scenario));
    }
    document.body.textContent = JSON.stringify(observations);
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
