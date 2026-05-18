import type { WebGpuProfilingDataV1 } from './onnxWorkerTypes';
import type { RuntimeProvider } from './onnxTypes';
import { sendRuntimeMessage } from '../shared/messages';

export type OrtDebugReport = {
  timestamp: string;
  model: string;
  provider: string;
  success: boolean;
  error?: string;
  profilingLog: WebGpuProfilingDataV1[];
};

export async function downloadDebugReport(
  model: string,
  provider: RuntimeProvider,
  success: boolean,
  error?: string,
  profilingLog?: WebGpuProfilingDataV1[],
): Promise<void> {
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

  const reportJson = JSON.stringify(report, null, 2);
  const filename = `ort-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  try {
    const response = await sendRuntimeMessage({
      type: 'mt:download-debug-report',
      reportJson,
      filename,
    });
    if (!response.ok) {
      console.warn('[ort-debug] 下载调试报告失败:', response.error);
      fallbackDownload(reportJson, filename);
    }
  } catch {
    fallbackDownload(reportJson, filename);
  }
}

function fallbackDownload(reportJson: string, filename: string): void {
  const blob = new Blob([reportJson], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}