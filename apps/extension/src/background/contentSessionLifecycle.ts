import type { ExtensionBrowserApi } from '../shared/extensionRuntime';
import { readContentSessionIdFromPortName } from '../shared/contentSession';

export function registerContentSessionLifecycle(
  api: ExtensionBrowserApi,
  onSessionClosed: (contentSessionId: string, tabId?: number) => void,
): void {
  api.runtime?.onConnect?.addListener((port) => {
    const contentSessionId = readContentSessionIdFromPortName(port.name);
    if (!contentSessionId) return;

    let closed = false;
    port.onDisconnect.addListener(() => {
      if (closed) return;
      closed = true;
      const tabId = port.sender?.tab?.id;
      if (typeof tabId === 'number') onSessionClosed(contentSessionId, tabId);
      else onSessionClosed(contentSessionId);
    });
  });
}
