export class SerialInferenceQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async onIdle(): Promise<void> {
    await this.tail;
  }
}
