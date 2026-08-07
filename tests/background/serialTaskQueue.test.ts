import { describe, expect, it, vi } from 'vitest';
import { SerialTaskQueue } from '../../apps/extension/src/background/serialTaskQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('SerialTaskQueue', () => {
  it('cancels only matching work that has not started', async () => {
    const queue = new SerialTaskQueue<string>();
    const activeGate = deferred<string>();
    const pendingRun = vi.fn(async () => 'pending');
    const otherRun = vi.fn(async () => 'other');

    const active = queue.enqueue(() => activeGate.promise, 'session-a');
    const pending = queue.enqueue(pendingRun, 'session-a');
    const other = queue.enqueue(otherRun, 'session-b');
    const pendingRejection = expect(pending).rejects.toThrow('来源页面已关闭');

    expect(queue.cancelPendingForSession('session-a')).toBe(1);
    await pendingRejection;
    expect(pendingRun).not.toHaveBeenCalled();

    activeGate.resolve('active');
    await expect(active).resolves.toBe('active');
    await expect(other).resolves.toBe('other');
    expect(otherRun).toHaveBeenCalledOnce();
  });

  it('rejects work that reaches the queue after its session already closed', async () => {
    const queue = new SerialTaskQueue<string>();
    const run = vi.fn(async () => 'late');

    expect(queue.cancelPendingForSession('closed-session')).toBe(0);
    await expect(queue.enqueue(run, 'closed-session')).rejects.toThrow('来源页面已关闭');
    expect(run).not.toHaveBeenCalled();
  });
});
