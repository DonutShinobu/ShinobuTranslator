import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPipelineRecord } from '@shinobu/image-pipeline';
import {
  isLocalPipelineClientMessage,
  isLocalPipelineHostMessage,
  LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE,
  supportsLocalPipelineStructuredClone,
} from '@shinobu/image-pipeline/protocol';

describe('local pipeline native Blob transport validation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires the experiment and an actual Blob probe', () => {
    const probe = new Blob([Uint8Array.of(83)], { type: LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE });
    expect(supportsLocalPipelineStructuredClone(probe)).toBe(false);
    vi.stubGlobal('__shinobuColdStartStructuredClone', true);
    expect(supportsLocalPipelineStructuredClone(probe)).toBe(true);
    expect(supportsLocalPipelineStructuredClone({})).toBe(false);
    expect(supportsLocalPipelineStructuredClone(new Blob(['x']))).toBe(false);
    expect(supportsLocalPipelineStructuredClone(new Blob(['xx'], { type: probe.type }))).toBe(false);
  });

  it('rejects malformed, wrong-size, or mixed native/base64 input', () => {
    const start = {
      type: 'start', jobId: 'test',
      file: { name: 'source.png', type: 'image/png', size: 1, lastModified: 0 },
      config: {
        sourceLang: 'ja', targetLang: 'zh-CN', translator: 'google_web', llmProvider: 'openai',
        llmAuthMode: 'api_key', llmBaseUrl: '', llmModel: '', typesetDebug: false,
        eraseDebug: false, collectDebugLog: false, ocrEngine: 'paddleocr_v6_medium', processMode: 'erase',
      },
      input: { chunkCount: 0, totalChars: 0 }, binaryFile: new Blob(['x'], { type: 'image/png' }),
    };
    expect(isLocalPipelineClientMessage(start)).toBe(true);
    expect(isLocalPipelineClientMessage({ ...start, config: { ...start.config, llmOcrFilter: true } })).toBe(true);
    expect(isLocalPipelineClientMessage({ ...start, config: { ...start.config, llmOcrFilter: 'true' } })).toBe(false);
    expect(isLocalPipelineClientMessage({ ...start, binaryFile: {} })).toBe(false);
    expect(isLocalPipelineClientMessage({ ...start, binaryFile: new Blob(['xx']) })).toBe(false);
    expect(isLocalPipelineClientMessage({ ...start, input: { chunkCount: 1, totalChars: 4 } })).toBe(false);
  });

  it('rejects malformed, wrong-type, mixed or orphan native PNG artifacts', () => {
    const result = {
      type: 'result-meta', jobId: 'test', status: 'completed',
      result: { contentType: 'image/png', chunkCount: 0, totalChars: 0 },
      resultBlob: new Blob(['png'], { type: 'image/png' }),
      summary: { image: { width: 1, height: 1 }, detectedRegionCount: 0, stageTimings: [], runtimeStages: [] },
      record: createPipelineRecord({ image: { width: 1, height: 1 }, ocr: [], ordered: [] }, { strategy: 'source-native' }),
    };
    expect(isLocalPipelineHostMessage(result)).toBe(true);
    expect(isLocalPipelineHostMessage({ ...result, resultBlob: {} })).toBe(false);
    expect(isLocalPipelineHostMessage({ ...result, resultBlob: new Blob(['x'], { type: 'image/jpeg' }) })).toBe(false);
    expect(isLocalPipelineHostMessage({ ...result, result: { ...result.result, chunkCount: 1, totalChars: 4 } })).toBe(false);
    expect(isLocalPipelineHostMessage({ ...result, debugBlob: result.resultBlob })).toBe(false);
  });
});
