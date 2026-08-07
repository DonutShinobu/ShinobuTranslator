export type PageArtifactKind = 'source-snapshot' | 'translated-result';

export class PageArtifactQuotaError extends Error {
  readonly errorCode = 'page_artifact_quota' as const;

  constructor(message = '页面产物存储空间不足', options?: ErrorOptions) {
    super(message, options);
    this.name = 'PageArtifactQuotaError';
  }
}

export type PageArtifactRef = {
  id: string;
  tabId: number;
  contentSessionId: string;
  kind: PageArtifactKind;
  name: string;
  type: string;
  size: number;
};

export type PageArtifactWireFile = {
  base64: string;
  contentType: string;
  filename: string;
};

export type PageArtifactCommand =
  | { operation: 'probe'; contentSessionId: string }
  | {
      operation: 'put';
      contentSessionId: string;
      kind: PageArtifactKind;
      file: PageArtifactWireFile;
    }
  | { operation: 'read'; contentSessionId: string; ref: PageArtifactRef }
  | { operation: 'delete'; contentSessionId: string; ref: PageArtifactRef }
  | { operation: 'clear'; contentSessionId: string };

export type PageArtifactCommandResult<C extends PageArtifactCommand> =
  C['operation'] extends 'probe'
    ? { available: true } | { available: false; reason: string }
    : C['operation'] extends 'put'
      ? PageArtifactRef
      : C['operation'] extends 'read'
        ? PageArtifactWireFile
        : { cleared: true };

export type PageArtifactResult =
  | { available: true }
  | { available: false; reason: string }
  | PageArtifactRef
  | PageArtifactWireFile
  | { cleared: true };

export function isPageArtifactKind(value: unknown): value is PageArtifactKind {
  return value === 'source-snapshot' || value === 'translated-result';
}

export function isPageArtifactRef(value: unknown): value is PageArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.id === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/u.test(ref.id)
    && Number.isSafeInteger(ref.tabId)
    && typeof ref.contentSessionId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/u.test(ref.contentSessionId)
    && isPageArtifactKind(ref.kind)
    && typeof ref.name === 'string'
    && typeof ref.type === 'string'
    && typeof ref.size === 'number'
    && Number.isSafeInteger(ref.size)
    && ref.size >= 0;
}
