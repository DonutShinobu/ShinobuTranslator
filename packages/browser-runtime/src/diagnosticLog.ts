export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DiagnosticLogCategory =
  | 'app.config'
  | 'runtime.message'
  | 'pipeline.stage'
  | 'model.runtime'
  | 'pipeline.detect'
  | 'pipeline.bubble'
  | 'pipeline.ocr'
  | 'pipeline.inpaint'
  | 'pipeline.typeset'
  | 'llm.api'
  | 'image.io'
  | 'extension.api'
  | 'ui.perf'
  | 'error';

export type DiagnosticLogContext =
  | 'popup'
  | 'content'
  | 'background'
  | 'offscreen'
  | 'worker';

export type DiagnosticLogSource = {
  context: DiagnosticLogContext;
  module?: string;
};

export type DiagnosticLogError = {
  name?: string;
  code?: string;
  message: string;
  stack?: string;
  cause?: unknown;
};

export type DiagnosticLogEvent = {
  id: string;
  sessionId: string;
  runId?: string;
  timestamp: string;
  level: DiagnosticLogLevel;
  category: DiagnosticLogCategory;
  source: DiagnosticLogSource;
  message: string;
  data?: Record<string, unknown>;
  error?: DiagnosticLogError;
};

export type DiagnosticLogEventInput = Omit<
  DiagnosticLogEvent,
  'id' | 'sessionId' | 'timestamp'
> & {
  id?: string;
  sessionId?: string;
  timestamp?: string;
};

const secretKeyPattern =
  /(api[_-]?key|authorization|cookie|token|access[_-]?token|refresh[_-]?token|bearer|secret|password|code_verifier|codeVerifier|client_secret)/iu;
const bearerPattern = /Bearer\s+[A-Za-z0-9._~+/=-]+/giu;
const imageDataUrlPattern = /^data:image\/[^;]+;base64,/iu;
const longTextLimit = 12_000;
const maxArrayItems = 80;
const maxObjectKeys = 120;

let fallbackIdCounter = 0;

export function createDiagnosticId(prefix = 'diag'): string {
  const randomPart =
    typeof crypto !== 'undefined'
    && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${(fallbackIdCounter += 1).toString(36)}`;
  return `${prefix}-${randomPart}`;
}

export function normalizeDiagnosticTimestamp(
  timestamp: unknown,
  fallback = new Date().toISOString(),
): string {
  return typeof timestamp === 'string' && timestamp.length > 0
    ? timestamp
    : fallback;
}

export function truncateDiagnosticText(
  text: string,
  limit = longTextLimit,
): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...[TRUNCATED:${text.length - limit}]`;
}

function redactString(value: string): string {
  if (imageDataUrlPattern.test(value)) {
    return `[IMAGE_DATA_URL_REDACTED:${value.length}]`;
  }
  return value.replace(bearerPattern, 'Bearer [REDACTED]');
}

type DiagnosticRedactionState = {
  seen: WeakSet<object>;
};

function redactDiagnosticValueInternal(
  value: unknown,
  keyHint: string,
  depth: number,
  state: DiagnosticRedactionState,
): unknown {
  if (keyHint && secretKeyPattern.test(keyHint)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    return truncateDiagnosticText(redactString(value));
  }
  if (
    typeof value === 'number'
    || typeof value === 'boolean'
    || value === null
    || value === undefined
  ) {
    return value;
  }
  if (
    (typeof value === 'object' && value !== null)
    || typeof value === 'function'
  ) {
    const objectValue = value as object;
    if (state.seen.has(objectValue)) {
      return '[CIRCULAR]';
    }
    state.seen.add(objectValue);
  }
  if (value instanceof Error) {
    if (depth >= 8) return '[TRUNCATED_DEPTH]';
    const extended = value as Error & {
      code?: unknown;
      stage?: unknown;
    };
    const out: DiagnosticLogError & { stage?: string } = {
      name: value.name,
      message: truncateDiagnosticText(redactString(value.message)),
    };
    if (typeof extended.code === 'string') {
      out.code = truncateDiagnosticText(redactString(extended.code));
    }
    if (typeof extended.stage === 'string') {
      out.stage = truncateDiagnosticText(redactString(extended.stage));
    }
    if (typeof value.stack === 'string') {
      out.stack = truncateDiagnosticText(redactString(value.stack));
    }
    if (value.cause !== undefined) {
      out.cause = redactDiagnosticValueInternal(
        value.cause,
        'cause',
        depth + 1,
        state,
      );
    }
    return out;
  }
  if (Array.isArray(value)) {
    if (depth >= 8) {
      return '[TRUNCATED_DEPTH]';
    }
    const sliced = value
      .slice(0, maxArrayItems)
      .map((item) =>
        redactDiagnosticValueInternal(
          item,
          keyHint,
          depth + 1,
          state,
        ));
    if (value.length > maxArrayItems) {
      sliced.push(`[TRUNCATED_ARRAY:${value.length - maxArrayItems}]`);
    }
    return sliced;
  }
  if (typeof value === 'object') {
    if (depth >= 8) {
      return '[TRUNCATED_DEPTH]';
    }
    const out: Record<string, unknown> = {};
    let index = 0;
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (index >= maxObjectKeys) {
        out.__truncatedKeys =
          Object.keys(value as Record<string, unknown>).length
          - maxObjectKeys;
        break;
      }
      out[key] = redactDiagnosticValueInternal(
        nested,
        key,
        depth + 1,
        state,
      );
      index += 1;
    }
    return out;
  }
  return String(value);
}

export function redactDiagnosticValue(
  value: unknown,
  keyHint = '',
  depth = 0,
): unknown {
  return redactDiagnosticValueInternal(
    value,
    keyHint,
    depth,
    { seen: new WeakSet<object>() },
  );
}

export function toDiagnosticError(
  error: unknown,
): DiagnosticLogError {
  if (error instanceof Error) {
    return redactDiagnosticValue(error) as DiagnosticLogError;
  }
  return {
    message: String(redactDiagnosticValue(error)),
  };
}

export function createDiagnosticEvent(
  input: DiagnosticLogEventInput,
  defaultSessionId: string,
): DiagnosticLogEvent {
  const event: DiagnosticLogEvent = {
    id: input.id ?? createDiagnosticId('event'),
    sessionId: input.sessionId ?? defaultSessionId,
    runId: input.runId,
    timestamp: normalizeDiagnosticTimestamp(input.timestamp),
    level: input.level,
    category: input.category,
    source: {
      context: input.source.context,
      module: input.source.module,
    },
    message: String(redactDiagnosticValue(input.message)),
  };

  if (input.data) {
    event.data = redactDiagnosticValue(input.data) as Record<
      string,
      unknown
    >;
  }
  if (input.error) {
    event.error = redactDiagnosticValue(
      input.error,
    ) as DiagnosticLogError;
  }
  return event;
}
