import type {
  RuntimeStageStatus,
  StageTiming,
  StageTimingCardData,
  StageTimingCardParallelLane,
  StageTimingCardRuntime,
  TranslationDebugInfo,
} from './types';

export { downloadJson, toErrorMessage } from '../../shared/utils';

export function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType || 'image/jpeg' });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片数据失败'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('导出译图失败'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

export function inferFileExtension(contentType: string, sourceUrl: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  try {
    const format = new URL(sourceUrl).searchParams.get('format');
    if (format) return format;
  } catch {
    // ignore
  }
  return 'jpg';
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0ms';
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)}s`;
  return `${Math.round(durationMs)}ms`;
}

const stageLabelMap: Record<string, string> = {
  load: '加载图片',
  preload: '加载模型',
  detect: '文本检测',
  ocr: '文字识别',
  merge: '合并文本',
  parallel: '并行处理',
  translate: '翻译文本',
  mask_refine: '细化遮罩',
  inpaint: '去除文字',
  bubble: '气泡检测',
  order: '文本排序',
  typeset: '文字排版',
  done: '完成',
};

const runtimeModelLabels: Record<RuntimeStageStatus['model'], string> = {
  detector: '检测',
  ocr: 'OCR',
  inpaint: '去字',
};

const orderedRuntimeModels: RuntimeStageStatus['model'][] = ['detector', 'ocr', 'inpaint'];
const parallelChildStages = new Set(['translate', 'mask_refine', 'inpaint']);

function formatPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent >= 10) return `${Math.round(percent)}%`;
  return `${percent.toFixed(1)}%`;
}

export function getStageLabel(stage: string, fallback?: string): string {
  return stageLabelMap[stage] ?? fallback ?? stage;
}

export function formatStageLabel(timing: StageTiming): string {
  return getStageLabel(timing.stage, timing.label);
}

export function formatRuntimeProvider(stage: RuntimeStageStatus): string {
  if (!stage.enabled) return '未启用';
  if (!stage.provider) return '未知';
  if (stage.provider === 'wasm') return 'cpu(wasm)';
  if (stage.provider === 'webnn') return `webnn/${stage.webnnDeviceType ?? 'default'}`;
  return stage.provider;
}

export function formatRuntimeStagesLine(runtimeStages: RuntimeStageStatus[]): string {
  if (runtimeStages.length === 0) return '';
  const stageByModel = new Map(runtimeStages.map((stage) => [stage.model, stage]));
  const parts: string[] = [];
  for (const model of orderedRuntimeModels) {
    const stage = stageByModel.get(model);
    if (!stage) continue;
    parts.push(`${runtimeModelLabels[model]}=${formatRuntimeProvider(stage)}`);
  }
  if (parts.length === 0) return '';
  return `运行时: ${parts.join(' / ')}`;
}

function toRuntimeCardItems(runtimeStages: RuntimeStageStatus[]): StageTimingCardRuntime[] {
  const stageByModel = new Map(runtimeStages.map((stage) => [stage.model, stage]));
  return orderedRuntimeModels.map((model) => {
    const stage = stageByModel.get(model);
    if (!stage) {
      return {
        model,
        label: runtimeModelLabels[model],
        providerText: '未知',
        detail: '未收到运行时状态',
        status: 'unknown',
      };
    }
    return {
      model,
      label: runtimeModelLabels[model],
      providerText: formatRuntimeProvider(stage),
      detail: stage.detail,
      status: stage.enabled ? 'enabled' : 'disabled',
    };
  });
}

function safeDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
}

function isFiniteCount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function formatTranslationDebugSummary(translationDebug: TranslationDebugInfo): string {
  const parts: string[] = [];
  const requestedCount = translationDebug.llmBatchRequestedRegionCount;
  const hitCount = translationDebug.llmBatchHitRegionCount;
  if (isFiniteCount(requestedCount) && isFiniteCount(hitCount)) {
    parts.push(`${hitCount}/${requestedCount} 命中`);
  }

  if (isFiniteCount(translationDebug.llmFallbackRegionCount) && translationDebug.llmFallbackRegionCount > 0) {
    parts.push(`回退 ${translationDebug.llmFallbackRegionCount} 个`);
  } else if (translationDebug.llmFallbackUsed) {
    parts.push('有回退');
  } else if (translationDebug.llmFallbackUsed !== undefined) {
    parts.push('无回退');
  }
  if (isFiniteCount(translationDebug.llmFallbackRequestCount) && translationDebug.llmFallbackRequestCount > 0) {
    parts.push(`${translationDebug.llmFallbackRequestCount} 次回退请求`);
  }

  return parts.length > 0 ? parts.join('，') : '无回退';
}

function hasParallelStage(stageTimings: StageTiming[]): boolean {
  return stageTimings.some((timing) => timing.stage === 'parallel');
}

function toDisplayStageTimings(stageTimings: StageTiming[]): StageTiming[] {
  if (!hasParallelStage(stageTimings)) {
    return stageTimings;
  }
  return stageTimings.filter((timing) => !parallelChildStages.has(timing.stage));
}

function findStageTiming(stageTimings: StageTiming[], stage: string): StageTiming | undefined {
  return stageTimings.find((timing) => timing.stage === stage);
}

function buildParallelLanes(
  stageTimings: StageTiming[],
  translationDebug?: TranslationDebugInfo | null,
  timelineOffsetPercent = 0,
  timelineWidthPercent = 100,
): StageTimingCardParallelLane[] | undefined {
  const parallelTiming = findStageTiming(stageTimings, 'parallel');
  if (!parallelTiming) {
    return undefined;
  }

  const laneDrafts: Array<{
    timing: StageTiming;
    startMs: number;
    durationMs: number;
    detailText?: string;
  }> = [];
  const translateTiming = findStageTiming(stageTimings, 'translate');
  if (translateTiming) {
    const durationMs = safeDuration(translateTiming.durationMs);
    if (durationMs > 0) {
      laneDrafts.push({
        timing: translateTiming,
        startMs: 0,
        durationMs,
        detailText: translationDebug ? formatTranslationDebugSummary(translationDebug) : undefined,
      });
    }
  }

  const maskRefineTiming = findStageTiming(stageTimings, 'mask_refine');
  const maskRefineDurationMs = maskRefineTiming ? safeDuration(maskRefineTiming.durationMs) : 0;
  if (maskRefineTiming && maskRefineDurationMs > 0) {
    laneDrafts.push({
      timing: maskRefineTiming,
      startMs: 0,
      durationMs: maskRefineDurationMs,
    });
  }

  const inpaintTiming = findStageTiming(stageTimings, 'inpaint');
  const inpaintDurationMs = inpaintTiming ? safeDuration(inpaintTiming.durationMs) : 0;
  if (inpaintTiming && inpaintDurationMs > 0) {
    laneDrafts.push({
      timing: inpaintTiming,
      startMs: maskRefineDurationMs,
      durationMs: inpaintDurationMs,
    });
  }

  if (laneDrafts.length === 0) {
    return undefined;
  }

  const scaleDurationMs = laneDrafts.reduce(
    (maxMs, lane) => Math.max(maxMs, lane.startMs + lane.durationMs),
    0,
  );
  if (scaleDurationMs <= 0) {
    return undefined;
  }

  return laneDrafts.map((lane) => {
    const localOffsetPercent = (lane.startMs / scaleDurationMs) * 100;
    const localWidthPercent = (lane.durationMs / scaleDurationMs) * 100;
    return {
      stage: lane.timing.stage,
      label: formatStageLabel(lane.timing),
      durationMs: lane.durationMs,
      durationText: formatDuration(lane.durationMs),
      offsetPercent: localOffsetPercent,
      widthPercent: localWidthPercent,
      localOffsetPercent,
      localWidthPercent,
      timelineOffsetPercent: timelineOffsetPercent + (localOffsetPercent * timelineWidthPercent) / 100,
      timelineWidthPercent: (localWidthPercent * timelineWidthPercent) / 100,
      detailText: lane.detailText,
    };
  });
}

function getStageDetailText(
  timing: StageTiming,
  stageTimings: StageTiming[],
  translationDebug?: TranslationDebugInfo | null,
): string | undefined {
  if (timing.stage === 'translate' && translationDebug) {
    return formatTranslationDebugSummary(translationDebug);
  }
  if (timing.stage !== 'parallel') {
    return undefined;
  }

  const parallelLanes = buildParallelLanes(stageTimings, translationDebug);
  if (!parallelLanes) {
    return undefined;
  }
  return `明细: ${parallelLanes.map((lane) => {
    const detailText = lane.detailText ? ` (${lane.detailText})` : '';
    return `${lane.label} ${lane.durationText}${detailText}`;
  }).join(' / ')}`;
}

export function buildStageTimingCardData(
  totalDurationMs: number,
  stageTimings: StageTiming[],
  runtimeStages: RuntimeStageStatus[],
  expanded: boolean,
  translationDebug?: TranslationDebugInfo | null,
): StageTimingCardData {
  const displayStageTimings = toDisplayStageTimings(stageTimings);
  const stageTotalMs = displayStageTimings.reduce((sum, timing) => sum + safeDuration(timing.durationMs), 0);
  let stageOffsetPercent = 0;
  const stages = displayStageTimings.map((timing) => {
    const durationMs = safeDuration(timing.durationMs);
    const widthPercent = stageTotalMs > 0 ? (durationMs / stageTotalMs) * 100 : 0;
    const offsetPercent = stageOffsetPercent;
    stageOffsetPercent += widthPercent;
    const fallbackText = getStageDetailText(timing, stageTimings, translationDebug);
    return {
      stage: timing.stage,
      label: formatStageLabel(timing),
      durationMs,
      durationText: formatDuration(durationMs),
      offsetPercent,
      widthPercent,
      percent: widthPercent,
      percentText: formatPercent(widthPercent),
      fallbackText,
      parallelLanes: timing.stage === 'parallel'
        ? buildParallelLanes(stageTimings, translationDebug, offsetPercent, widthPercent)
        : undefined,
    };
  });
  return {
    totalDurationMs,
    totalText: `总耗时：${formatDuration(totalDurationMs)}`,
    stageTotalMs,
    expanded,
    stages,
    runtimes: toRuntimeCardItems(runtimeStages),
  };
}

export function formatElapsedText(
  totalDurationMs: number,
  stageTimings: StageTiming[],
  runtimeStages: RuntimeStageStatus[],
  showStageDetails: boolean,
  showRuntimeStages: boolean,
  translationDebug?: TranslationDebugInfo | null,
): string {
  const totalLine = `总耗时：${formatDuration(totalDurationMs)}`;
  const runtimeLine = showRuntimeStages ? formatRuntimeStagesLine(runtimeStages) : '';
  if (!showStageDetails || stageTimings.length === 0) {
    return runtimeLine ? [totalLine, runtimeLine].join('\n') : totalLine;
  }
  const detailLines = toDisplayStageTimings(stageTimings).map((timing) => {
    const label = formatStageLabel(timing);
    const detailText = getStageDetailText(timing, stageTimings, translationDebug);
    return detailText
      ? `${label}：${formatDuration(timing.durationMs)} (${detailText})`
      : `${label}：${formatDuration(timing.durationMs)}`;
  });
  return runtimeLine
    ? [totalLine, runtimeLine, ...detailLines].join('\n')
    : [totalLine, ...detailLines].join('\n');
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
