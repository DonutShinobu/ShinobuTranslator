import { describe, expect, it, vi } from 'vitest';
import {
  createConformancePipelineHostComposition,
} from '../../apps/extension/conformance/pipelineHostComposition';
import {
  createDetectorFailureProviderExecution,
} from '../../apps/extension/conformance/pipelineHostComposition.detectorFailure';
import {
  createTranslationFailureTransport,
} from '../../apps/extension/conformance/pipelineHostComposition.translationFailure';
import {
  createPipelineHostExecutionTrace,
} from '../../apps/extension/conformance/pipelineHostExecutionTrace.lifecycle';
import {
  extensionBuildTargets,
} from '../../apps/extension/scripts/build-targets.mjs';
import {
  WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY,
} from '../../src/benchmark/providerExecution';

describe('conformance test composition root', () => {
  it('injects the shared WebGPU policy and fixed translation transport', async () => {
    const composition = createConformancePipelineHostComposition();

    expect(composition.providerPolicy)
      .toBe(WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY);
    expect(composition.providerPolicy.contract).toEqual({
      id: 'shinobu.webgpu-benchmark-provider-policy',
      version: 1,
    });
    expect(composition.providerPolicy.rules).toHaveLength(4);
    expect(await composition.translationTransport.translatePlain({
      text: '原文',
      from: 'ja',
      to: 'zh-CHS',
    })).toBe('固定译文');
    expect(await composition.translationTransport.requestChatCompletion({
      body: {
        model: 'deepseek-chat',
        messages: [],
      },
      proxyConfig: {
        provider: 'deepseek',
        authMode: 'api_key',
        baseUrl: 'https://api.deepseek.com/v1',
      },
    })).toEqual({
      choices: [{ message: { content: '固定译文' } }],
    });
  });

  it('builds isolated Chrome and Firefox test packages without changing store targets', () => {
    expect(extensionBuildTargets).toMatchObject({
      chrome: {
        browser: 'chrome',
        outDir: 'apps/extension/dist/chrome',
        release: true,
      },
      firefox: {
        browser: 'firefox',
        outDir: 'apps/extension/dist/firefox',
        release: true,
      },
      'conformance-chrome': {
        browser: 'chrome',
        manifestTarget: 'chrome',
        outDir: 'apps/extension/dist/conformance/chrome',
        release: false,
        conformance: true,
      },
      'conformance-firefox': {
        browser: 'firefox',
        manifestTarget: 'firefox',
        outDir: 'apps/extension/dist/conformance/firefox',
        release: false,
        conformance: true,
      },
      'conformance-detector-chrome': {
        browser: 'chrome',
        outDir: 'apps/extension/dist/conformance/detector/chrome',
        release: false,
        conformance: true,
        conformanceProfile: 'detector-failure',
      },
      'conformance-detector-firefox': {
        browser: 'firefox',
        outDir: 'apps/extension/dist/conformance/detector/firefox',
        release: false,
        conformance: true,
        conformanceProfile: 'detector-failure',
      },
      'conformance-translation-chrome': {
        browser: 'chrome',
        outDir: 'apps/extension/dist/conformance/translation/chrome',
        release: false,
        conformance: true,
        conformanceProfile: 'translation-failure',
      },
      'conformance-translation-firefox': {
        browser: 'firefox',
        outDir: 'apps/extension/dist/conformance/translation/firefox',
        release: false,
        conformance: true,
        conformanceProfile: 'translation-failure',
      },
      'conformance-lifecycle-chrome': {
        browser: 'chrome',
        outDir: 'apps/extension/dist/conformance/lifecycle/chrome',
        release: false,
        conformance: true,
        conformanceProfile: 'lifecycle',
      },
      'conformance-lifecycle-firefox': {
        browser: 'firefox',
        outDir: 'apps/extension/dist/conformance/lifecycle/firefox',
        release: false,
        conformance: true,
        conformanceProfile: 'lifecycle',
      },
    });
  });

  it('injects detector session loss through the runtime capability seam', async () => {
    const resetRuntime = vi.fn(async () => undefined);
    const barriers: string[] = [];
    const capability = createDetectorFailureProviderExecution({
      policy: WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY,
      modelSession: {
        loadModel: async () => ({ runtime: ['webgpu'] }),
        loadSession: async () => ({
          sessionId: 'live-session',
          provider: 'webgpu',
          inputNames: ['images'],
          outputNames: ['det'],
        }),
        resetRuntime,
      },
    }, (barrier) => barriers.push(barrier));

    await expect(capability.modelSession.loadSession(
      'detector',
      'webgpu',
    )).resolves.toMatchObject({
      sessionId: 'conformance-lost-detector-session',
      provider: 'webgpu',
    });
    expect(resetRuntime).toHaveBeenCalledOnce();
    expect(barriers).toEqual(['detector-webgpu-inference-failed']);
  });

  it('injects retryable translation network failures at named barriers', async () => {
    const barriers: string[] = [];
    const transport = createTranslationFailureTransport(
      (barrier) => barriers.push(barrier),
    );

    await expect(transport.translatePlain({
      text: '原文',
      from: 'ja',
      to: 'zh-CHS',
    })).rejects.toMatchObject({
      name: 'TypeError',
      retryable: true,
      retryAfterMs: 1,
    });
    expect(barriers).toEqual(['translation-network-attempt-1']);
  });

  it('holds the second execution after its first partial result chunk', async () => {
    const operations: string[] = [];
    const trace = createPipelineHostExecutionTrace({
      executionOrdinal: 2,
      jobId: 'job-2',
      providerExecution: {},
      translationTransport: {},
      post: async (message) => {
        operations.push(message.progress.operation);
        return true;
      },
    });

    const blocked = trace.afterArtifactChunk('result', 0);
    await Promise.resolve();

    expect(operations).toEqual(['runtime-result-produced']);
    await expect(Promise.race([
      blocked.then(() => 'settled'),
      Promise.resolve('pending'),
    ])).resolves.toBe('pending');
  });
});
