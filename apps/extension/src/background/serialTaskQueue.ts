type PendingTask<T> = {
  contentSessionId?: string;
  run: () => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

/** A serial queue whose not-yet-started work can be removed by content session. */
export class SerialTaskQueue<T> {
  private readonly pending: Array<PendingTask<T>> = [];
  private readonly closedSessions = new Map<string, unknown>();
  private active = false;

  enqueue(
    run: () => Promise<T> | T,
    contentSessionId?: string,
  ): Promise<T> {
    if (contentSessionId && this.closedSessions.has(contentSessionId)) {
      return Promise.reject(this.closedSessions.get(contentSessionId));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        ...(contentSessionId ? { contentSessionId } : {}),
        run,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  cancelPendingForSession(
    contentSessionId: string,
    reason: unknown = new Error('来源页面已关闭'),
  ): number {
    this.closedSessions.set(contentSessionId, reason);
    let cancelled = 0;
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const task = this.pending[index];
      if (task?.contentSessionId !== contentSessionId) continue;
      this.pending.splice(index, 1);
      task.reject(reason);
      cancelled += 1;
    }
    return cancelled;
  }

  private pump(): void {
    if (this.active) return;
    const task = this.pending.shift();
    if (!task) return;

    this.active = true;
    void Promise.resolve()
      .then(task.run)
      .then(task.resolve, task.reject)
      .finally(() => {
        this.active = false;
        this.pump();
      });
  }
}
