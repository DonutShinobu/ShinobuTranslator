import type { ExtensionBrowserApi, ExtensionPort } from '../../shared/extensionRuntime';
import {
  extensionControlChangedEventType,
  extensionControlPortName,
  type ExtensionControlChangedEvent,
} from '../../shared/extensionControlTransport';
import type { ExtensionControlModule } from './extensionControl';

export function registerExtensionControlPort(
  api: ExtensionBrowserApi,
  module: ExtensionControlModule,
): void {
  api.runtime?.onConnect?.addListener((port: ExtensionPort) => {
    if (port.name !== extensionControlPortName) return;
    let connected = true;
    let unsubscribe: (() => void) | undefined;
    const disconnect = () => {
      if (!connected) return;
      connected = false;
      unsubscribe?.();
    };
    const post = (projection: ExtensionControlChangedEvent['projection']) => {
      if (!connected) return;
      try {
        port.postMessage({
          type: extensionControlChangedEventType,
          projection,
        } satisfies ExtensionControlChangedEvent);
      } catch {
        // The physical port can close before onDisconnect is dispatched.
        disconnect();
      }
    };
    unsubscribe = module.subscribe(post);
    port.onDisconnect.addListener(disconnect);
  });
}
