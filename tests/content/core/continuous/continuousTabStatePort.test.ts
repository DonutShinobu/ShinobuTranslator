import { describe, expect, it, vi } from 'vitest';
import { RuntimeContinuousTabStatePort } from '../../../../apps/extension/src/content/core/continuous/continuousTabStatePort';

describe('RuntimeContinuousTabStatePort', () => {
  it('reads and writes only the current tab session flag', async () => {
    let enabled = false;
    const send = vi.fn(async (message) => {
      if (message.type !== 'mt:continuous-tab-state') throw new Error('unexpected');
      if (message.command.operation === 'write') enabled = message.command.enabled;
      return {
        ok: true as const,
        type: 'mt:continuous-tab-state' as const,
        result: { enabled },
      };
    });
    const port = new RuntimeContinuousTabStatePort(send);

    await expect(port.read()).resolves.toBe(false);
    await expect(port.write(true)).resolves.toBeUndefined();
    await expect(port.read()).resolves.toBe(true);
  });
});
