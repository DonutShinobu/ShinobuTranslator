import type { RuntimeStageStatus, StageTiming, StageTimingCardData, StageTimingCardRuntime, TranslationDebugInfo } from './types';

export { toErrorMessage } from '../../shared/utils';

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

export function buildStageTimingCardData(
  totalDurationMs: number,
  stageTimings: StageTiming[],
  runtimeStages: RuntimeStageStatus[],
  expanded: boolean,
  translationDebug?: TranslationDebugInfo | null,
): StageTimingCardData {
  const stageTotalMs = stageTimings.reduce((sum, timing) => (
    Number.isFinite(timing.durationMs) && timing.durationMs > 0 ? sum + timing.durationMs : sum
  ), 0);
  const stages = stageTimings.map((timing) => {
    const durationMs = Number.isFinite(timing.durationMs) && timing.durationMs > 0 ? timing.durationMs : 0;
    const percent = stageTotalMs > 0 ? (durationMs / stageTotalMs) * 100 : 0;
    const fallbackText = timing.stage === 'translate' && translationDebug
      ? translationDebug.llmFallbackUsed ? '有回退' : '无回退'
      : undefined;
    return {
      stage: timing.stage,
      label: formatStageLabel(timing),
      durationMs,
      durationText: formatDuration(durationMs),
      percent,
      percentText: formatPercent(percent),
      fallbackText,
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
  const detailLines = stageTimings.map((timing) => {
    const label = formatStageLabel(timing);
    return `${label}：${formatDuration(timing.durationMs)}`;
  });
  const translateLineIndex = stageTimings.findIndex((t) => t.stage === 'translate');
  if (translateLineIndex >= 0 && translationDebug) {
    const fallbackTag = translationDebug.llmFallbackUsed ? '有回退' : '无回退';
    detailLines[translateLineIndex] += ` (${fallbackTag})`;
  }
  return runtimeLine
    ? [totalLine, runtimeLine, ...detailLines].join('\n')
    : [totalLine, ...detailLines].join('\n');
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function downloadJson(data: unknown, filenamePrefix: string): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${filenamePrefix}-${timestamp}.json`;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
