import { describe, expect, it, vi } from 'vitest';
import { registerContentSessionLifecycle } from '../../apps/extension/src/background/contentSessionLifecycle';
import { toContentSessionPortName } from '../../apps/extension/src/shared/contentSession';
import { createLocalExtensionPortPair } from '../../apps/extension/src/shared/localExtensionPort';
import type {
  ExtensionBrowserApi,
  ExtensionPort,
} from '../../apps/extension/src/shared/extensionRuntime';

describe('content session lifecycle', () => {
  it('reports a content session once when its lifecycle port disconnects', async () => {
    let acceptPort: ((port: ExtensionPort) => void) | undefined;
    const onSessionClosed = vi.fn();
    const api: ExtensionBrowserApi = {
      runtime: {
        onConnect: {
          addListener(listener) {
            acceptPort = listener;
          },
        },
      },
    };
    registerContentSessionLifecycle(api, onSessionClosed);
    const [contentPort, backgroundPort] = createLocalExtensionPortPair(
      toContentSessionPortName('session-1'),
    );
    acceptPort?.(backgroundPort);

    contentPort.disconnect();
    contentPort.disconnect();
    await Promise.resolve();

    expect(onSessionClosed).toHaveBeenCalledOnce();
    expect(onSessionClosed).toHaveBeenCalledWith('session-1');
  });

  it('ignores unrelated ports', async () => {
    let acceptPort: ((port: ExtensionPort) => void) | undefined;
    const onSessionClosed = vi.fn();
    registerContentSessionLifecycle({
      runtime: {
        onConnect: {
          addListener(listener) {
            acceptPort = listener;
          },
        },
      },
    }, onSessionClosed);
    const [clientPort, backgroundPort] = createLocalExtensionPortPair('other-port');
    acceptPort?.(backgroundPort);

    clientPort.disconnect();
    await Promise.resolve();

    expect(onSessionClosed).not.toHaveBeenCalled();
  });
});
