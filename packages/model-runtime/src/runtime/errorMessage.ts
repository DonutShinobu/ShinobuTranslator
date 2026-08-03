export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export type SerializedRuntimeError = {
  name: string;
  code: string;
  message: string;
  stack?: string;
};

export function serializeRuntimeError(
  error: unknown,
  code = 'MODEL_RUNTIME_ERROR',
): SerializedRuntimeError {
  if (error instanceof Error) {
    const extended = error as Error & { code?: unknown };
    return {
      name: error.name,
      code: typeof extended.code === 'string' ? extended.code : code,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: 'Error', code, message: toErrorMessage(error) };
}
