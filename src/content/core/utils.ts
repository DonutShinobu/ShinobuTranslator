import type { RuntimeStageStatus, StageTiming } from './types';

export function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType || 'image/jpeg' });
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

export function formatRuntimeProvider(stage: RuntimeStageStatus): string {
  if (!stage.enabled) return 'disabled';
  if (!stage.provider) return 'unknown';
  if (stage.provider === 'wasm') return 'cpu(wasm)';
  if (stage.provider === 'webnn') return `webnn/${stage.webnnDeviceType ?? 'default'}`;
  return stage.provider;
}

export function formatRuntimeStagesLine(runtimeStages: RuntimeStageStatus[]): string {
  if (runtimeStages.length === 0) return '';
  const orderedModels: RuntimeStageStatus['model'][] = ['detector', 'ocr', 'inpaint'];
  const modelLabels: Record<RuntimeStageStatus['model'], string> = {
    detector: '检测',
    ocr: 'OCR',
    inpaint: '去字',
  };
  const stageByModel = new Map(runtimeStages.map((stage) => [stage.model, stage]));
  const parts: string[] = [];
  for (const model of orderedModels) {
    const stage = stageByModel.get(model);
    if (!stage) continue;
    parts.push(`${modelLabels[model]}=${formatRuntimeProvider(stage)}`);
  }
  if (parts.length === 0) return '';
  return `运行时: ${parts.join(' / ')}`;
}

export function formatElapsedText(
  totalDurationMs: number,
  stageTimings: StageTiming[],
  runtimeStages: RuntimeStageStatus[],
  showStageDetails: boolean,
  showRuntimeStages: boolean,
): string {
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
  const totalLine = `总耗时：${formatDuration(totalDurationMs)}`;
  const runtimeLine = showRuntimeStages ? formatRuntimeStagesLine(runtimeStages) : '';
  if (!showStageDetails || stageTimings.length === 0) {
    return runtimeLine ? [totalLine, runtimeLine].join('\n') : totalLine;
  }
  const detailLines = stageTimings.map((timing) => {
    const label = stageLabelMap[timing.stage] ?? timing.label ?? timing.stage;
    return `${label}：${formatDuration(timing.durationMs)}`;
  });
  return runtimeLine
    ? [totalLine, runtimeLine, ...detailLines].join('\n')
    : [totalLine, ...detailLines].join('\n');
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
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
