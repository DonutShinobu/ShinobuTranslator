import { createTranslatorCore } from '@shinobu/translator-core';
import { describe, expect, it } from 'vitest';
import { createDefaultWebSettings } from '../../packages/shared-config/src';
import type {
  PipelineConfig,
  PipelineProgress,
} from '../../packages/image-pipeline/src';
import type { WebPipelineRecord } from '../../apps/web/src/domain/pipelineRecord';
import {
  LocalHistory,
  MemoryLocalHistoryAssetAdapter,
  MemoryLocalHistoryIndexAdapter,
} from '../../apps/web/src/features/history/localHistory';
import {
  createProcessingRuntime,
  ProcessingRuntimeBlockedError,
  type ProcessingRuntimeDependencies,
  type ProcessingRuntimeEnvironmentSnapshot,
} from '../../apps/web/src/features/processing/processingRuntime';
import {
  createProcessingBatchWorkspace,
  type ProcessingBatchWorkspaceDependencies,
} from '../../apps/web/src/features/processing/processingBatch';
import type {
  WebPipelineInput,
  WebPipelineResult,
  WebTranslatorCore,
} from '../../apps/web/src/runtime/webPipeline';

function successfulCore(
  observedApiKeys: string[],
  apiKey = '',
): WebTranslatorCore {
  const core = createTranslatorCore<
    WebPipelineInput,
    PipelineConfig,
    PipelineProgress,
    WebPipelineResult
  >(async ({ input }) => {
    observedApiKeys.push(apiKey);
    return {
      status: 'completed',
      image: new Blob([`translated:${input.file.name}`], { type: 'image/png' }),
      summary: {
        image: { width: 1200, height: 1800 },
        detectedRegionCount: 0,
        stageTimings: [],
        runtimeStages: [],
        translationDebug: null,
        ocrDebug: null,
        ocrPostFilterDebug: null,
        typesetDebug: null,
      },
      record: {} as WebPipelineRecord,
    };
  });
  return {
    ...core,
    dispose: async () => undefined,
  };
}

function readyDependencies(
  observedApiKeys: string[],
): ProcessingRuntimeDependencies {
  return {
    environment: {
      snapshot: () => ({ online: true, visibility: 'visible' }),
      subscribe: () => () => undefined,
    },
    readModelConsent: () => true,
    writeModelConsent: () => undefined,
    inspectModelPackage: async () => ({
      installed: true,
      storedBytes: 500,
      totalBytes: 500,
    }),
    installModelPackage: async () => undefined,
    probeCapability: async () => ({
      ok: true,
      supportLevel: 'desktop',
      backend: 'webgpu',
      workPixelBudget: 8_000_000,
      storagePersistent: true,
      wasmThreads: true,
      webgpu: true,
    }),
    probeModels: async () => ({ ok: true, provider: 'webgpu' }),
    inspectStorage: async () => ({
      status: 'ready',
      usageBytes: 10,
      quotaBytes: 1_000_000_000,
      availableBytes: 999_999_990,
      persisted: true,
    }),
    createCore: (capabilities) => successfulCore(
      observedApiKeys,
      capabilities?.textTranslation.apiKey,
    ),
    fallbackWorkPixelBudget: 4_000_000,
  };
}

describe('processing runtime module', () => {
  it('prepares a lease that runs with the validated locked credential', async () => {
    const observedApiKeys: string[] = [];
    const runtime = createProcessingRuntime(readyDependencies(observedApiKeys));
    await runtime.dispatch({ type: 'refresh' });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const request = {
      settings,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'locked-runtime-key',
      },
      pendingOriginalBytes: 1024,
    } as const;

    expect(runtime.assess(request)).toMatchObject({
      status: 'ready',
      backend: 'webgpu',
      workPixelBudget: 8_000_000,
    });

    const lease = await runtime.prepare(request);
    const execution = lease.run({
      file: new File(['source'], 'source.png', { type: 'image/png' }),
      workingCopy: { width: 1200, height: 1800 },
    });
    const result = await execution.result;

    expect(await result.image.text()).toBe('translated:source.png');
    expect(observedApiKeys).toEqual(['locked-runtime-key']);
    lease.release();
    await runtime.dispatch({ type: 'dispose' });
  });

  it('turns accepted model consent into an installed and probed runtime', async () => {
    const dependencies = readyDependencies([]);
    let installed = false;
    let consent = false;
    dependencies.readModelConsent = () => consent;
    dependencies.writeModelConsent = (accepted) => {
      consent = accepted;
    };
    dependencies.inspectModelPackage = async () => ({
      installed,
      storedBytes: installed ? 500 : 0,
      totalBytes: 500,
    });
    dependencies.installModelPackage = async ({ onProgress }) => {
      onProgress({
        phase: 'complete',
        assetIndex: 1,
        assetCount: 1,
        downloadedBytes: 500,
        totalBytes: 500,
      });
      installed = true;
    };
    const runtime = createProcessingRuntime(dependencies);
    await runtime.dispatch({ type: 'refresh' });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const request = {
      settings,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
      pendingOriginalBytes: 0,
    };

    expect(runtime.assess(request)).toMatchObject({
      status: 'blocked',
      code: 'MODEL_CONSENT_REQUIRED',
    });

    await runtime.dispatch({ type: 'accept-model-download' });

    expect(consent).toBe(true);
    expect(runtime.snapshot()).toMatchObject({
      status: 'ready',
      modelConsent: true,
      modelPackage: { status: 'installed', storedBytes: 500 },
      modelProbe: { status: 'ready', provider: 'webgpu' },
    });
    expect(runtime.assess(request)).toMatchObject({ status: 'ready' });
    await runtime.dispatch({ type: 'dispose' });
  });

  it('retries a failed accepted model installation instead of only rechecking it', async () => {
    const dependencies = readyDependencies([]);
    let installed = false;
    let installAttempts = 0;
    dependencies.inspectModelPackage = async () => ({
      installed,
      storedBytes: installed ? 500 : 0,
      totalBytes: 500,
    });
    dependencies.installModelPackage = async () => {
      installAttempts += 1;
      if (installAttempts === 1) throw new Error('temporary download failure');
      installed = true;
    };
    const runtime = createProcessingRuntime(dependencies);
    await runtime.dispatch({ type: 'refresh' });

    await expect(runtime.dispatch({ type: 'accept-model-download' }))
      .rejects.toThrow('temporary download failure');
    expect(runtime.snapshot().modelPackage.status).toBe('failed');

    await runtime.dispatch({ type: 'retry' });

    expect(installAttempts).toBe(2);
    expect(runtime.snapshot()).toMatchObject({
      status: 'ready',
      modelPackage: { status: 'installed' },
      modelProbe: { status: 'ready' },
    });
    await runtime.dispatch({ type: 'dispose' });
  });

  it('marks an in-flight model installation paused when the page is hidden', async () => {
    let environment: ProcessingRuntimeEnvironmentSnapshot = {
      online: true,
      visibility: 'visible',
    };
    let environmentListener:
      | ((snapshot: ProcessingRuntimeEnvironmentSnapshot) => void)
      | undefined;
    const dependencies = readyDependencies([]);
    dependencies.environment = {
      snapshot: () => environment,
      subscribe(listener) {
        environmentListener = listener;
        return () => {
          environmentListener = undefined;
        };
      },
    };
    dependencies.inspectModelPackage = async () => ({
      installed: false,
      storedBytes: 250,
      totalBytes: 500,
    });
    dependencies.installModelPackage = ({ signal, onProgress }) => new Promise(
      (_resolve, reject) => {
        onProgress({
          phase: 'downloading',
          assetIndex: 1,
          assetCount: 1,
          downloadedBytes: 250,
          totalBytes: 500,
        });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      },
    );
    const runtime = createProcessingRuntime(dependencies);
    await runtime.dispatch({ type: 'refresh' });

    const installation = runtime.dispatch({ type: 'accept-model-download' });
    await Promise.resolve();
    environment = { online: true, visibility: 'hidden' };
    environmentListener?.(environment);
    await installation;

    expect(runtime.snapshot()).toMatchObject({
      status: 'suspended',
      modelPackage: {
        status: 'paused',
        storedBytes: 250,
        totalBytes: 500,
      },
    });
    await runtime.dispatch({ type: 'dispose' });
  });

  it('lets cancellation interrupt an in-flight model installation immediately', async () => {
    const dependencies = readyDependencies([]);
    let finishInstallation: (() => void) | undefined;
    let installationSignal: AbortSignal | undefined;
    dependencies.inspectModelPackage = async () => ({
      installed: false,
      storedBytes: 100,
      totalBytes: 500,
    });
    dependencies.installModelPackage = ({ signal }) => new Promise<void>(
      (resolve, reject) => {
        finishInstallation = resolve;
        installationSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      },
    );
    const runtime = createProcessingRuntime(dependencies);
    await runtime.dispatch({ type: 'refresh' });

    const installation = runtime.dispatch({ type: 'accept-model-download' });
    await Promise.resolve();
    const cancellation = runtime.dispatch({ type: 'cancel-model-download' });

    finishInstallation?.();
    await Promise.all([installation, cancellation]);
    expect(installationSignal?.aborted).toBe(true);
    expect(runtime.snapshot().modelPackage.status).toBe('missing');
    await runtime.dispatch({ type: 'dispose' });
  });

  it('contains capability probe exceptions as a stable blocker', async () => {
    const dependencies = readyDependencies([]);
    dependencies.probeCapability = async () => {
      throw new Error('capability worker failed to start');
    };
    const runtime = createProcessingRuntime(dependencies);
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];

    await expect(runtime.dispatch({ type: 'refresh' })).resolves.toBeUndefined();

    expect(runtime.snapshot().status).toBe('blocked');
    expect(runtime.assess({
      settings,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
      pendingOriginalBytes: 0,
    })).toMatchObject({
      status: 'blocked',
      code: 'CAPABILITY_FAILED',
      detail: 'capability worker failed to start',
    });
    await runtime.dispatch({ type: 'dispose' });
  });

  it('contains model probe exceptions and allows retrying the probe', async () => {
    const dependencies = readyDependencies([]);
    let attempts = 0;
    dependencies.probeModels = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('model probe worker crashed');
      return { ok: true, provider: 'wasm' };
    };
    const runtime = createProcessingRuntime(dependencies);
    await expect(runtime.dispatch({ type: 'refresh' })).resolves.toBeUndefined();

    expect(runtime.snapshot()).toMatchObject({
      status: 'blocked',
      modelProbe: {
        status: 'failed',
        error: 'model probe worker crashed',
      },
    });

    await runtime.dispatch({ type: 'retry' });

    expect(runtime.snapshot()).toMatchObject({
      status: 'ready',
      modelProbe: { status: 'ready', provider: 'wasm' },
    });
    const settings = createDefaultWebSettings('zh-CN');
    expect(runtime.assess({
      settings,
      credential: {
        providerId: settings.translationProviderId,
        target: settings.providerProfiles[settings.translationProviderId].baseUrl,
        value: 'runtime-only',
      },
      pendingOriginalBytes: 0,
    })).toMatchObject({
      status: 'ready',
      backend: 'wasm',
      workPixelBudget: 4_000_000,
    });
    await runtime.dispatch({ type: 'dispose' });
  });

  it('invalidates an existing lease when the page becomes hidden', async () => {
    let environment: ProcessingRuntimeEnvironmentSnapshot = {
      online: true,
      visibility: 'visible',
    };
    let environmentListener:
      | ((snapshot: ProcessingRuntimeEnvironmentSnapshot) => void)
      | undefined;
    let disposeCount = 0;
    const dependencies = readyDependencies([]);
    dependencies.environment = {
      snapshot: () => environment,
      subscribe(listener) {
        environmentListener = listener;
        return () => {
          environmentListener = undefined;
        };
      },
    };
    const baseCore = dependencies.createCore();
    dependencies.createCore = () => ({
      ...baseCore,
      dispose: async () => {
        disposeCount += 1;
      },
    });
    const runtime = createProcessingRuntime(dependencies);
    await runtime.dispatch({ type: 'refresh' });
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];
    const lease = await runtime.prepare({
      settings,
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
      pendingOriginalBytes: 0,
    });
    await lease.run({
      file: new File(['source'], 'source.png', { type: 'image/png' }),
      workingCopy: { width: 1200, height: 1800 },
    }).result;

    environment = { online: true, visibility: 'hidden' };
    environmentListener?.(environment);

    expect(runtime.snapshot().status).toBe('suspended');
    expect(disposeCount).toBe(1);
    expect(() => lease.run({
      file: new File(['source'], 'source.png', { type: 'image/png' }),
      workingCopy: { width: 1200, height: 1800 },
    })).toThrow(ProcessingRuntimeBlockedError);
    await runtime.dispatch({ type: 'dispose' });
  });

  it('keeps ProcessingBatch fail-closed when the model probe is not ready', async () => {
    const dependencies = readyDependencies([]);
    dependencies.probeModels = async () => ({
      ok: false,
      error: 'detector probe failed',
    });
    const runtime = createProcessingRuntime(dependencies);
    await runtime.dispatch({ type: 'refresh' });
    const history = new LocalHistory(
      new MemoryLocalHistoryIndexAdapter(),
      new MemoryLocalHistoryAssetAdapter(),
    );
    const workspaceDependencies = {
      history,
      runtime,
      getCore: dependencies.createCore,
      storage: { admit: async () => undefined },
      createId: () => 'runtime-blocked-batch',
    } as ProcessingBatchWorkspaceDependencies & { runtime: typeof runtime };
    const workspace = createProcessingBatchWorkspace(workspaceDependencies);
    const settings = createDefaultWebSettings('zh-CN');
    const provider = settings.providerProfiles[settings.translationProviderId];

    await expect(workspace.open({
      kind: 'continuous-camera',
      initialImages: [],
      settings,
      versions: {
        app: '0.1.0',
        core: '0.8.1',
        model: 'model-v1',
        configSchema: 1,
      },
      credential: {
        providerId: settings.translationProviderId,
        target: provider.baseUrl,
        value: 'runtime-only',
      },
    })).rejects.toMatchObject({
      decision: {
        status: 'blocked',
        code: 'MODEL_PROBE_FAILED',
        detail: 'detector probe failed',
      },
    });
    expect(await history.list()).toEqual([]);
    await runtime.dispatch({ type: 'dispose' });
  });

  it('rejects a missing or mismatched credential at the runtime seam', async () => {
    const runtime = createProcessingRuntime(readyDependencies([]));
    await runtime.dispatch({ type: 'refresh' });
    const settings = createDefaultWebSettings('zh-CN');

    expect(runtime.assess({
      settings,
      credential: {
        providerId: settings.translationProviderId,
        target: 'https://stale.example/v1',
        value: 'runtime-only',
      },
      pendingOriginalBytes: 0,
    })).toMatchObject({
      status: 'blocked',
      code: 'CREDENTIAL_TARGET_MISMATCH',
    });

    await expect(runtime.prepare({
      settings,
      credential: {
        providerId: settings.translationProviderId,
        target: settings.providerProfiles[settings.translationProviderId].baseUrl,
        value: '   ',
      },
      pendingOriginalBytes: 0,
    })).rejects.toMatchObject({
      decision: {
        status: 'blocked',
        code: 'CREDENTIAL_MISSING',
      },
    });
    await runtime.dispatch({ type: 'dispose' });
  });
});
