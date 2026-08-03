import { describe, expect, it, vi } from 'vitest';
import { createLocalExtensionPortPair } from '../../src/shared/localExtensionPort';

describe('Local ExtensionPort pair', () => {
  it('exchanges isolated messages in both directions and propagates disconnect', async () => {
    const [left, right] = createLocalExtensionPortPair('pipeline-host');
    const leftMessages: unknown[] = [];
    const rightMessages: unknown[] = [];
    const rightDisconnected = vi.fn();
    left.onMessage.addListener((message) => leftMessages.push(message));
    right.onMessage.addListener((message) => rightMessages.push(message));
    right.onDisconnect.addListener(rightDisconnected);

    const fromLeft = { type: 'host-ready', nested: { value: 1 } };
    left.postMessage(fromLeft);
    fromLeft.nested.value = 2;
    right.postMessage({ type: 'ready', jobId: 'job-1' });

    await vi.waitFor(() => {
      expect(rightMessages).toEqual([{
        type: 'host-ready',
        nested: { value: 1 },
      }]);
      expect(leftMessages).toEqual([{ type: 'ready', jobId: 'job-1' }]);
    });

    left.disconnect();
    await vi.waitFor(() => expect(rightDisconnected).toHaveBeenCalledOnce());
    expect(() => right.postMessage({ type: 'late' })).toThrow('Port 已断开');
  });
});
