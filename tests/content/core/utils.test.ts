import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStageStatus, StageTiming } from '../../../src/content/core/types';
import {
  buildStageTimingCardData,
  formatElapsedText,
  resolveImageReferrerPolicy,
} from '../../../src/content/core/utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveImageReferrerPolicy', () => {
  it('prefers the image element policy over the document policy', () => {
    vi.stubGlobal('document', {
      querySelectorAll: vi.fn(() => [{ content: 'no-referrer' }]),
    });

    expect(resolveImageReferrerPolicy({
      referrerPolicy: 'origin',
    })).toBe('origin');
  });

  it('normalizes case, ignores invalid meta values, and supports legacy meta keywords', () => {
    vi.stubGlobal('document', {
      querySelectorAll: vi.fn(() => [
        { content: 'ORIGIN' },
        { content: 'not-a-policy' },
        { content: 'ALWAYS' },
      ]),
    });

    expect(resolveImageReferrerPolicy()).toBe('unsafe-url');
  });
});

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
    expect(card.stages.map((stage) => [
      Math.round(stage.offsetPercent * 10) / 10,
      Math.round(stage.widthPercent * 10) / 10,
    ])).toEqual([
      [0, 25],
      [25, 75],
    ]);
    expect(card.stages[1]?.fallbackText).toBe('有回退');
    expect(card.runtimes.map((runtime) => [runtime.label, runtime.providerText, runtime.status])).toEqual([
      ['检测', 'webgpu', 'enabled'],
      ['气泡', '未知', 'unknown'],
      ['OCR', 'cpu(wasm)', 'enabled'],
      ['去字', '未知', 'unknown'],
    ]);
  });

  it('summarizes batch translation details', () => {
    const stageTimings: StageTiming[] = [
      { stage: 'detect', label: '文本检测', durationMs: 100 },
      { stage: 'translate', label: '翻译文本', durationMs: 900 },
    ];

    const card = buildStageTimingCardData(1000, stageTimings, [], true, {
      llmBatchRequestedRegionCount: 5,
      llmBatchHitRegionCount: 5,
      llmFallbackUsed: false,
      llmFallbackRegionCount: 0,
    });

    expect(card.stages[1]?.fallbackText).toBe('5/5 命中，无回退');
  });

  it('collapses overlapping parallel child stages in timing percentages', () => {
    const stageTimings: StageTiming[] = [
      { stage: 'load', label: '加载图片', durationMs: 100 },
      { stage: 'translate', label: '翻译为中文', durationMs: 1000 },
      { stage: 'mask_refine', label: '细化去字遮罩', durationMs: 100 },
      { stage: 'inpaint', label: '去字', durationMs: 300 },
      { stage: 'parallel', label: '并行处理(翻译 + 去字)', durationMs: 1100 },
      { stage: 'typeset', label: '文字排版', durationMs: 200 },
    ];

    const card = buildStageTimingCardData(1500, stageTimings, [], true, {
      llmBatchRequestedRegionCount: 3,
      llmBatchHitRegionCount: 2,
      llmFallbackUsed: true,
      llmFallbackRegionCount: 1,
      llmFallbackRequestCount: 1,
    });

    expect(card.stageTotalMs).toBe(1400);
    expect(card.stages.map((stage) => stage.stage)).toEqual(['load', 'parallel', 'typeset']);
    expect(card.stages.map((stage) => stage.percentText)).toEqual(['7.1%', '79%', '14%']);
    expect(card.stages.map((stage) => [
      stage.stage,
      Math.round(stage.offsetPercent * 10) / 10,
      Math.round(stage.widthPercent * 10) / 10,
    ])).toEqual([
      ['load', 0, 7.1],
      ['parallel', 7.1, 78.6],
      ['typeset', 85.7, 14.3],
    ]);
    expect(card.stages[1]?.parallelLanes?.map((lane) => [
      lane.stage,
      lane.durationText,
      Math.round(lane.offsetPercent * 10) / 10,
      Math.round(lane.widthPercent * 10) / 10,
    ])).toEqual([
      ['translate', '1.00s', 0, 100],
      ['mask_refine', '100ms', 0, 10],
      ['inpaint', '300ms', 10, 30],
    ]);
    expect(card.stages[1]?.parallelLanes?.map((lane) => [
      lane.stage,
      Math.round(lane.timelineOffsetPercent * 10) / 10,
      Math.round(lane.timelineWidthPercent * 10) / 10,
    ])).toEqual([
      ['translate', 7.1, 78.6],
      ['mask_refine', 7.1, 7.9],
      ['inpaint', 15, 23.6],
    ]);
    expect(card.stages[1]?.fallbackText).toBe(
      '明细: 翻译文本 1.00s (2/3 命中，回退 1 个，1 次回退请求) / 细化遮罩 100ms / 去除文字 300ms',
    );

    expect(formatElapsedText(1500, stageTimings, [], true, false, {
      llmBatchRequestedRegionCount: 3,
      llmBatchHitRegionCount: 2,
      llmFallbackUsed: true,
      llmFallbackRegionCount: 1,
      llmFallbackRequestCount: 1,
    })).toBe([
      '总耗时：1.50s',
      '加载图片：100ms',
      '并行处理：1.10s (明细: 翻译文本 1.00s (2/3 命中，回退 1 个，1 次回退请求) / 细化遮罩 100ms / 去除文字 300ms)',
      '文字排版：200ms',
    ].join('\n'));
  });
});
