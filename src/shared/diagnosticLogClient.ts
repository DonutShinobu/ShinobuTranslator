import { getChromeApi } from './chrome';
import {
  createDiagnosticEvent,
  createDiagnosticId,
  toDiagnosticError,
  type DiagnosticLogEventInput,
} from './diagnosticLog';

const sessionId = createDiagnosticId('session');

export function getDiagnosticSessionId(): string {
  return sessionId;
}

export function createDiagnosticRunId(prefix = 'run'): string {
  return createDiagnosticId(prefix);
}

export function emitDiagnosticLog(input: DiagnosticLogEventInput): void {
  const chromeApi = getChromeApi();
  if (!chromeApi?.runtime?.sendMessage) return;
  const event = createDiagnosticEvent(input, sessionId);
  try {
    chromeApi.runtime.sendMessage({ type: 'mt:diagnostic-log-event', event }, () => {
      // Best-effort diagnostic path. Read lastError so Chrome does not complain.
      void chromeApi.runtime?.lastError?.message;
    });
  } catch {
    // Logging must never break translation.
  }
}

export function emitDiagnosticError(input: Omit<DiagnosticLogEventInput, 'level' | 'error'> & { error: unknown }): void {
  emitDiagnosticLog({
    ...input,
    level: 'error',
    error: toDiagnosticError(input.error),
  });
}
