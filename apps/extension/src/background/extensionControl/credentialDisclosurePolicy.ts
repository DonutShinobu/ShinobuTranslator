import type { ExtensionMessageSender } from '../../shared/extensionRuntime';

export function isTrustedPopupSender(
  sender: ExtensionMessageSender,
  popupUrl: string,
): boolean {
  const senderUrl = sender.url ?? sender.documentUrl;
  return popupUrl.length > 0
    && senderUrl === popupUrl
    && sender.tab === undefined;
}
