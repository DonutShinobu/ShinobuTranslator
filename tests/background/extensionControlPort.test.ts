import { describe, expect, it, vi } from 'vitest';
import { registerExtensionControlPort } from '../../apps/extension/src/background/extensionControl/extensionControlPort';
import type { ExtensionControlModule } from '../../apps/extension/src/background/extensionControl/extensionControl';
import type { ExtensionControlProjection } from '../../apps/extension/src/shared/extensionControl';
import {
  extensionControlPortName,
} from '../../apps/extension/src/shared/extensionControlTransport';
import { createLocalExtensionPortPair } from '../../apps/extension/src/shared/localExtensionPort';
import type {
  ExtensionBrowserApi,
  ExtensionPort,
} from '../../apps/extension/src/shared/extensionRuntime';

describe('ExtensionControl event port', () => {
  it('drops a disconnected popup observer before onDisconnect is delivered', async () => {
    let acceptPort: ((port: ExtensionPort) => void) | undefined;
    let publishProjection: ((projection: ExtensionControlProjection) => void) | undefined;
    const unsubscribe = vi.fn();
    const read = vi.fn(() => new Promise<ExtensionControlProjection>(() => undefined));
    const api: ExtensionBrowserApi = {
      runtime: {
        onConnect: {
          addListener(listener) {
            acceptPort = listener;
          },
        },
      },
    };
    const module = {
      read,
      subscribe(listener: (projection: ExtensionControlProjection) => void) {
        publishProjection = listener;
        return unsubscribe;
      },
    } as unknown as ExtensionControlModule;
    registerExtensionControlPort(api, module);
    const [popupPort, backgroundPort] = createLocalExtensionPortPair(
      extensionControlPortName,
    );
    acceptPort?.(backgroundPort);
    expect(read).not.toHaveBeenCalled();

    popupPort.disconnect();

    expect(() => publishProjection?.({} as ExtensionControlProjection)).not.toThrow();
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
