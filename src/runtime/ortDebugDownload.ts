import type { WebGpuProfilingDataV1 } from './onnxWorkerTypes';
import type { RuntimeProvider } from './onnxTypes';

export type OrtDebugReport = {
  timestamp: string;
  model: string;
  provider: string;
  success: boolean;
  error?: string;
  profilingLog: WebGpuProfilingDataV1[];
};

export function downloadDebugReport(
  model: string,
  provider: RuntimeProvider,
  success: boolean,
  error?: string,
  profilingLog?: WebGpuProfilingDataV1[],
): void {
  if (!profilingLog || profilingLog.length === 0) {
    return;
  }

  const report: OrtDebugReport = {
    timestamp: new Date().toISOString(),
    model,
    provider,
    success,
    error,
    profilingLog,
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const chromeApi = (globalThis as typeof globalThis & {
    chrome?: { downloads?: { download?: (options: { url: string; filename: string; saveAs?: boolean }) => Promise<number> } };
  }).chrome;

  if (chromeApi?.downloads?.download) {
    chromeApi.downloads.download({
      url,
      filename: `ort-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      saveAs: false,
    }).catch(() => {
      fallbackDownload(url);
    });
  } else {
    fallbackDownload(url);
  }
}

function fallbackDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = `ort-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}