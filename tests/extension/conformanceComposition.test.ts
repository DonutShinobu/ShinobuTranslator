import { describe, expect, it } from 'vitest';
import {
  createConformancePipelineHostComposition,
} from '../../apps/extension/conformance/pipelineHostComposition';
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
    });
  });
});
