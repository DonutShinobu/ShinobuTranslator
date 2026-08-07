export const contentSessionPortPrefix = 'mt:content-session:';

let activeContentSessionId: string | undefined;

export function createContentSessionId(): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return randomId.replace(/[^A-Za-z0-9_-]/gu, '');
}

export function setActiveContentSessionId(sessionId: string | undefined): void {
  activeContentSessionId = sessionId;
}

export function getActiveContentSessionId(): string | undefined {
  return activeContentSessionId;
}

export function toContentSessionPortName(sessionId: string): string {
  return `${contentSessionPortPrefix}${sessionId}`;
}

export function readContentSessionIdFromPortName(name: string): string | null {
  if (!name.startsWith(contentSessionPortPrefix)) return null;
  const sessionId = name.slice(contentSessionPortPrefix.length);
  return /^[A-Za-z0-9_-]{1,128}$/u.test(sessionId) ? sessionId : null;
}

export function isContentSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
