export function createListenerEvent<T>() {
  const listeners = new Set<(value: T) => void>();
  let removalCount = 0;
  return {
    raw: {
      addListener(listener: (value: T) => void): void {
        listeners.add(listener);
      },
      removeListener(listener: (value: T) => void): void {
        if (listeners.delete(listener)) removalCount += 1;
      },
    },
    emit(value: T): void {
      for (const listener of listeners) listener(value);
    },
    removals(): number {
      return removalCount;
    },
  };
}
