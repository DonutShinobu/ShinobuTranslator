import {
  createDiagnosticEvent,
  createDiagnosticId,
  toDiagnosticError,
  type DiagnosticLogEventInput,
  type DiagnosticLogContext,
} from './diagnosticLog';
import type { RuntimeMessageSender } from './messages';

const sessionId = createDiagnosticId('session');

export function getDiagnosticSessionId(): string {
  return sessionId;
}

export function createDiagnosticRunId(prefix = 'run'): string {
  return createDiagnosticId(prefix);
}

export function getDiagnosticExecutionContext(
  context: DiagnosticLogContext,
): DiagnosticLogContext {
  return context;
}

export function emitDiagnosticLog(
  input: DiagnosticLogEventInput,
  sendMessage?: RuntimeMessageSender,
): void {
  void emitDiagnosticLogAsync(input, sendMessage);
}

export async function emitDiagnosticLogAsync(
  input: DiagnosticLogEventInput,
  sendMessage?: RuntimeMessageSender,
): Promise<boolean> {
  if (!sendMessage) return false;
  const event = createDiagnosticEvent(input, sessionId);
  try {
    const response = await sendMessage({
      type: 'mt:diagnostic-log-event',
      event,
    });
    return response.ok && response.type === 'mt:diagnostic-log-event';
  } catch {
    return false;
  }
}

export function emitDiagnosticError(
  input: Omit<DiagnosticLogEventInput, 'level' | 'error'> & { error: unknown },
  sendMessage?: RuntimeMessageSender,
): void {
  emitDiagnosticLog({
    ...input,
    level: 'error',
    error: toDiagnosticError(input.error),
  }, sendMessage);
}
