import { describe, expect, it } from 'vitest';
import { isRuntimeMessage } from '../../apps/extension/src/shared/messages';

describe('page artifact runtime messages', () => {
  it('accepts valid commands and rejects forged artifact references', () => {
    expect(isRuntimeMessage({
      type: 'mt:page-artifact',
      command: {
        operation: 'put',
        contentSessionId: 'session-1',
        kind: 'source-snapshot',
        file: {
          base64: 'c291cmNl',
          contentType: 'image/png',
          filename: 'page.png',
        },
      },
    })).toBe(true);

    expect(isRuntimeMessage({
      type: 'mt:page-artifact',
      command: {
        operation: 'read',
        contentSessionId: 'session-1',
        ref: {
          id: '../forged',
          tabId: 1,
          contentSessionId: 'session-1',
          kind: 'source-snapshot',
          name: 'page.png',
          type: 'image/png',
          size: 1,
        },
      },
    })).toBe(false);
  });
});
