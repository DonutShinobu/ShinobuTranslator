import { describe, expect, it } from 'vitest';
import type { RuntimeStageStatus, StageTiming } from '../../../src/content/core/types';
import { buildStageTimingCardData } from '../../../src/content/core/utils';

describe('buildStageTimingCardData', () => {
  it('builds stage percentages, translation fallback, and runtime statuses', () => {
    const stageTimings: StageTiming[] = [
      { stage: 'detect', label: '文本检测', durationMs: 100 },
      { stage: 'translate', label: '翻译文本', durationMs: 300 },
    ];
    const runtimeStages: RuntimeStageStatus[] = [
      {
        model: 'detector',
        enabled: true,
        provider: 'webgpu',
        detail: 'detector 模型已加载',
      },
      {
        model: 'ocr',
        enabled: true,
        provider: 'wasm',
        detail: 'ocr 模型已加载',
      },
    ];

    const card = buildStageTimingCardData(500, stageTimings, runtimeStages, true, {
      llmFallbackUsed: true,
    });

    expect(card.expanded).toBe(true);
    expect(card.totalText).toBe('总耗时：500ms');
    expect(card.stageTotalMs).toBe(400);
    expect(card.stages.map((stage) => stage.percentText)).toEqual(['25%', '75%']);
    expect(card.stages[1]?.fallbackText).toBe('有回退');
    expect(card.runtimes.map((runtime) => [runtime.label, runtime.providerText, runtime.status])).toEqual([
      ['检测', 'webgpu', 'enabled'],
      ['OCR', 'cpu(wasm)', 'enabled'],
      ['去字', '未知', 'unknown'],
    ]);
  });
});
