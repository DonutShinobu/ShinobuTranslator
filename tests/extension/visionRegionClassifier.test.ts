import { describe, expect, it, vi } from 'vitest';
import type { VisionRegion, PipelineConfig } from '@shinobu/image-pipeline';
import type { TextTranslationTransport } from '@shinobu/text-translation';
import { normalizeSettings, toPipelineConfig } from '../../apps/extension/src/shared/config';
import { classifyVisionRegions } from '../../apps/extension/src/shared/visionRegionClassifier';

const region: VisionRegion = {
  id: 'r1', text: 'あ', ocrConfidence: 0.6, detectorConfidence: 0.7,
  direction: 'v', lineCount: 1, inBubble: false, areaPercent: 12,
  boxPercent: { x: 10, y: 20, width: 30, height: 40 }, imageDataUrl: 'data:image/jpeg;base64,YQ==',
};
const config = toPipelineConfig(normalizeSettings({ translator: 'llm' }));
const response = (content: string) => ({ choices: [{ message: { content } }] });
function transport(requestChatCompletion: TextTranslationTransport['requestChatCompletion']): TextTranslationTransport {
  return { requestChatCompletion, translatePlain: vi.fn() };
}

describe('LLM OCR region classifier', () => {
  it.each([
    { llmProvider: 'mimo', llmModel: 'mimo-v2.6-pro', llmAuthMode: 'api_key', llmThinkingLevel: 'on' },
    { llmProvider: 'openai', llmModel: 'gpt-6-sol', llmAuthMode: 'openai_oauth', llmThinkingLevel: 'high' },
    { llmProvider: 'custom', llmModel: 'my-vision-model', llmAuthMode: 'api_key', llmBaseUrl: 'https://custom.example/v1', llmUseCustomModel: true },
  ] satisfies Partial<PipelineConfig>[])('uses the current $llmProvider model and access settings', async (overrides) => {
    const selected = { ...config, ...overrides };
    const request = vi.fn(async () => response('false_positive'));
    expect(await classifyVisionRegions([region], selected, transport(request))).toEqual(['r1']);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ model: selected.llmModel, messages: [
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: [
          expect.objectContaining({ type: 'text' }),
          { type: 'image_url', image_url: { url: region.imageDataUrl } },
        ] },
      ] }),
      proxyConfig: {
        provider: selected.llmProvider, authMode: selected.llmAuthMode, baseUrl: selected.llmBaseUrl,
        useCustomModel: selected.llmUseCustomModel, thinkingLevel: selected.llmThinkingLevel,
      },
    }));
  });

  it('only removes explicit false positives and retains uncertain, malformed and failed candidates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = vi.fn()
      .mockResolvedValueOnce(response('real_text'))
      .mockResolvedValueOnce(response('uncertain'))
      .mockResolvedValueOnce(response(' FALSE_POSITIVE \n'))
      .mockResolvedValueOnce(response('maybe false_positive'))
      .mockRejectedValueOnce(new Error('HTTP 429'));
    try {
      expect(await classifyVisionRegions(Array.from({ length: 5 }, (_, i) => ({ ...region, id: `r${i}` })), config, transport(request))).toEqual(['r2']);
      expect(warn).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });

  it('reports complete failure so the pipeline can preserve every region', async () => {
    await expect(classifyVisionRegions([region], config, transport(async () => response('')))).rejects.toThrow('响应无效');
  });

  it('stops starting new requests after cancellation', async () => {
    const controller = new AbortController();
    const cancelled = new DOMException('cancelled', 'AbortError');
    const request = vi.fn(async () => { controller.abort(cancelled); return response('false_positive'); });
    await expect(classifyVisionRegions(Array.from({ length: 8 }, () => region), config, transport(request), controller.signal)).rejects.toBe(cancelled);
    expect(request).toHaveBeenCalledOnce();
  });
});
