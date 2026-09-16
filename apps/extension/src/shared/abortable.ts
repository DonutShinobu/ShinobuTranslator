export function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
}

/** Reject promptly and detach the listener even if an underlying task hangs. */
export function abortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal?.reason ?? new DOMException('请求已取消', 'AbortError'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      throwIfSignalAborted(signal);
      return operation();
    }).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}
