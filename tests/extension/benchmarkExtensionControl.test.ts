import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyExtensionControlPatchInPage } from '../../benchmark/perf/src/extension-control-driver';

const originalChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;

afterEach(() => {
  const scope = globalThis as typeof globalThis & { chrome?: unknown };
  if (originalChrome === undefined) delete scope.chrome;
  else scope.chrome = originalChrome;
});

describe('benchmark extension control driver', () => {
  it('reads and replaces settings through the official control message', async () => {
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as { type?: string; command?: { kind?: string } };
      if (record.command?.kind === 'read') {
        return {
          ok: true,
          type: 'mt:extension-control',
          result: {
            kind: 'control-projection',
            projection: {
              revision: 7,
              settings: { processMode: 'translate', enableDebugLog: false },
              access: {},
            },
          },
        };
      }
      if (record.command?.kind === 'replace-settings') {
        return {
          ok: true,
          type: 'mt:extension-control',
          result: {
            kind: 'control-projection',
            projection: { revision: 8, settings: {}, access: {} },
          },
        };
      }
      if (record.type === 'mt:diagnostic-log-clear') {
        return { ok: true, type: 'mt:diagnostic-log-clear' };
      }
      throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
    });
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
      runtime: { sendMessage },
    };

    const revision = await applyExtensionControlPatchInPage({
      patch: { processMode: 'original', enableDebugLog: true },
      clearDiagnosticLog: true,
    });

    expect(revision).toBe(8);
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      type: 'mt:extension-control',
      command: { kind: 'read' },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      type: 'mt:extension-control',
      command: {
        kind: 'replace-settings',
        expectedRevision: 7,
        settings: {
          processMode: 'original',
          enableDebugLog: true,
        },
      },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(3, {
      type: 'mt:diagnostic-log-clear',
    });
  });
});
