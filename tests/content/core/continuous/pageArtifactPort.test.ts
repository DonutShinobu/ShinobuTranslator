import { describe, expect, it, vi } from 'vitest';
import { RuntimePageArtifactPort } from '../../../../apps/extension/src/content/core/continuous/pageArtifactPort';
import type { RuntimeMessage, RuntimeResponse } from '../../../../apps/extension/src/shared/messages';
import { PageArtifactQuotaError } from '../../../../apps/extension/src/shared/pageArtifacts';

describe('RuntimePageArtifactPort', () => {
  it('transfers files through the bound content session without retaining wire bytes', async () => {
    const ref = {
      id: 'artifact-1',
      tabId: 4,
      contentSessionId: 'session-1',
      kind: 'source-snapshot' as const,
      name: 'page.png',
      type: 'image/png',
      size: 6,
    };
    const send = vi.fn(async (message: RuntimeMessage): Promise<RuntimeResponse> => {
      if (message.type !== 'mt:page-artifact') throw new Error('unexpected');
      if (message.command.operation === 'put') {
        expect(atob(message.command.file.base64)).toBe('source');
        return { ok: true, type: 'mt:page-artifact', result: ref };
      }
      if (message.command.operation === 'read') {
        return {
          ok: true,
          type: 'mt:page-artifact',
          result: {
            base64: btoa('source'),
            contentType: 'image/png',
            filename: 'page.png',
          },
        };
      }
      return { ok: true, type: 'mt:page-artifact', result: { cleared: true } };
    });
    const port = new RuntimePageArtifactPort('session-1', send);

    const stored = await port.put({
      kind: 'source-snapshot',
      file: new File(['source'], 'page.png', { type: 'image/png' }),
    });
    expect(stored).toEqual(ref);
    await expect((await port.read(stored)).text()).resolves.toBe('source');
  });

  it('preserves quota failures across the runtime message boundary', async () => {
    const port = new RuntimePageArtifactPort('session-1', async () => ({
      ok: false,
      type: 'mt:page-artifact',
      error: '页面产物存储空间不足',
      errorCode: 'page_artifact_quota',
    }));

    await expect(port.put({
      kind: 'source-snapshot',
      file: new File(['source'], 'page.png'),
    })).rejects.toBeInstanceOf(PageArtifactQuotaError);
  });
});
