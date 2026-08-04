import { describe, expect, it } from 'vitest';
import { isTrustedPopupSender } from '../../apps/extension/src/background/extensionControl/credentialDisclosurePolicy';

describe('credential disclosure caller policy', () => {
  const popupUrl = 'chrome-extension://extension-id/popup.html';

  it('accepts only the extension popup document without a tab owner', () => {
    expect(isTrustedPopupSender({ url: popupUrl }, popupUrl)).toBe(true);
    expect(isTrustedPopupSender({ documentUrl: popupUrl }, popupUrl)).toBe(true);
    expect(isTrustedPopupSender({ url: popupUrl, tab: { id: 7 } }, popupUrl)).toBe(false);
    expect(isTrustedPopupSender({ url: 'https://example.com/page' }, popupUrl)).toBe(false);
    expect(isTrustedPopupSender({}, popupUrl)).toBe(false);
  });
});
