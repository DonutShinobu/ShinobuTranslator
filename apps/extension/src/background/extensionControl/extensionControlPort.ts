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
    const post = (projection: ExtensionControlChangedEvent['projection']) => {
      if (!connected) return;
      port.postMessage({
        type: extensionControlChangedEventType,
        projection,
      } satisfies ExtensionControlChangedEvent);
    };
    const unsubscribe = module.subscribe(post);
    port.onDisconnect.addListener(() => {
      connected = false;
      unsubscribe();
    });
    void module.read().then(post).catch(() => undefined);
  });
}
