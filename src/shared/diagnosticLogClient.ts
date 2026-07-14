import { getChromeApi } from './chrome';
import {
  createDiagnosticEvent,
  createDiagnosticId,
  toDiagnosticError,
  type DiagnosticLogEventInput,
  type DiagnosticLogContext,
} from './diagnosticLog';

const sessionId = createDiagnosticId('session');

export function getDiagnosticSessionId(): string {
  return sessionId;
}

export function createDiagnosticRunId(prefix = 'run'): string {
  return createDiagnosticId(prefix);
}

export function getDiagnosticExecutionContext(): DiagnosticLogContext {
  const locationValue = typeof location === 'undefined' ? null : location;
  if (locationValue?.protocol === 'chrome-extension:' && /\/offscreen\.html$/i.test(locationValue.pathname)) {
    return 'offscreen';
  }
  return 'content';
}

export function emitDiagnosticLog(input: DiagnosticLogEventInput): void {
  void emitDiagnosticLogAsync(input);
}

export function emitDiagnosticLogAsync(input: DiagnosticLogEventInput): Promise<boolean> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.runtime?.sendMessage) return Promise.resolve(false);
  const event = createDiagnosticEvent(input, sessionId);
  return new Promise((resolve) => {
    try {
      chromeApi.runtime?.sendMessage?.({ type: 'mt:diagnostic-log-event', event }, (response) => {
        const failed = Boolean(chromeApi.runtime?.lastError?.message);
        const acknowledged = Boolean(response && typeof response === 'object' && 'ok' in response && (response as { ok?: unknown }).ok === true);
        resolve(!failed && acknowledged);
      });
    } catch {
      resolve(false);
    }
  });
}

export function emitDiagnosticError(input: Omit<DiagnosticLogEventInput, 'level' | 'error'> & { error: unknown }): void {
  emitDiagnosticLog({
    ...input,
    level: 'error',
    error: toDiagnosticError(input.error),
  });
}
