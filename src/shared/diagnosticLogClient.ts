import { getExtensionApi } from './extensionRuntime';
import {
  createDiagnosticLogEmitter as createPackageDiagnosticLogEmitter,
  createDiagnosticId,
  toDiagnosticError,
  type DiagnosticLogEvent,
  type DiagnosticLogEventInput,
  type DiagnosticLogContext,
} from '@shinobu/diagnostics';

const sessionId = createDiagnosticId('session');

export function getDiagnosticSessionId(): string {
  return sessionId;
}

export function createDiagnosticRunId(prefix = 'run'): string {
  return createDiagnosticId(prefix);
}

export function getDiagnosticExecutionContext(): DiagnosticLogContext {
  const locationValue = typeof location === 'undefined' ? null : location;
  if (
    (locationValue?.protocol === 'chrome-extension:' || locationValue?.protocol === 'moz-extension:')
    && /\/(offscreen|background-firefox)\.html$/i.test(locationValue.pathname)
  ) {
    return 'pipeline-host';
  }
  return 'content';
}

export type DiagnosticLogEventSink = (
  event: DiagnosticLogEvent,
) => Promise<boolean>;

export type DiagnosticLogEmitter = {
  emit(input: DiagnosticLogEventInput): void;
  emitAsync(input: DiagnosticLogEventInput): Promise<boolean>;
};

export function createDiagnosticLogEmitter(
  sink: DiagnosticLogEventSink,
  emitterSessionId = sessionId,
): DiagnosticLogEmitter {
  return createPackageDiagnosticLogEmitter(sink, emitterSessionId);
}

const extensionDiagnosticLogEmitter = createDiagnosticLogEmitter((event) => {
  const chromeApi = getExtensionApi();
  if (!chromeApi?.runtime?.sendMessage) return Promise.resolve(false);
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
});

export function emitDiagnosticLog(input: DiagnosticLogEventInput): void {
  extensionDiagnosticLogEmitter.emit(input);
}

export function emitDiagnosticLogAsync(input: DiagnosticLogEventInput): Promise<boolean> {
  return extensionDiagnosticLogEmitter.emitAsync(input);
}

export function emitDiagnosticError(input: Omit<DiagnosticLogEventInput, 'level' | 'error'> & { error: unknown }): void {
  emitDiagnosticLog({
    ...input,
    level: 'error',
    error: toDiagnosticError(input.error),
  });
}
