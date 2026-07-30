import {
  createDiagnosticEvent,
  createDiagnosticId,
  toDiagnosticError,
  type DiagnosticLogContext,
  type DiagnosticLogEvent,
  type DiagnosticLogEventInput,
} from './diagnosticLog';

export type DiagnosticLogMessageSender = (
  message: {
    type: 'mt:diagnostic-log-event';
    event: DiagnosticLogEvent;
  },
) => Promise<{
  ok: boolean;
  type: string;
}>;

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
  sendMessage?: DiagnosticLogMessageSender,
): void {
  void emitDiagnosticLogAsync(input, sendMessage);
}

export async function emitDiagnosticLogAsync(
  input: DiagnosticLogEventInput,
  sendMessage?: DiagnosticLogMessageSender,
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
  input: Omit<
    DiagnosticLogEventInput,
    'level' | 'error'
  > & { error: unknown },
  sendMessage?: DiagnosticLogMessageSender,
): void {
  emitDiagnosticLog({
    ...input,
    level: 'error',
    error: toDiagnosticError(input.error),
  }, sendMessage);
}
