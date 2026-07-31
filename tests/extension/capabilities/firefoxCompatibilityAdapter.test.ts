import { describe, expect, it } from 'vitest';
import {
  createChromeCompatibilityCapabilities,
} from '../../../apps/extension/src/capabilities/chromeCompatibility';

function listenerEvent() {
  return {
    addListener: () => undefined,
    removeListener: () => undefined,
  };
}

function createCompatibilityApi() {
  return {
    runtime: {
      id: 'firefox-extension-id',
      lastError: undefined,
    },
    permissions: {
      contains: (
        _details: unknown,
        complete: (granted: boolean) => void,
      ) => complete(false),
      request: (
        _details: unknown,
        complete: (granted: boolean) => void,
      ) => complete(false),
      onAdded: listenerEvent(),
      onRemoved: listenerEvent(),
    },
    webRequest: {
      onHeadersReceived: listenerEvent(),
    },
    declarativeNetRequest: {
      updateDynamicRules: async () => undefined,
      updateSessionRules: async () => undefined,
    },
  };
}

describe('Firefox downstream compatibility capabilities', () => {
  it('defers optional cookie namespace validation until cookie access', async () => {
    const compatibility = createChromeCompatibilityCapabilities(
      createCompatibilityApi(),
    );

    const background = compatibility.background();

    await expect(background.cookies.read(
      { url: 'https://gemini.google.com/' },
      [{ kind: 'cookie-access' }],
    )).rejects.toMatchObject({
      capability: 'extension-cookies',
      code: 'context-unavailable',
      operation: 'initialize',
    });
  });

  it('registers referrer observation without Chrome-only extraHeaders', () => {
    let extraInfoSpec: readonly string[] | undefined;
    const api = createCompatibilityApi();
    api.webRequest.onHeadersReceived.addListener = (
      _listener?: unknown,
      _filter?: unknown,
      values?: readonly string[],
    ) => {
      extraInfoSpec = values;
    };
    const compatibility = createChromeCompatibilityCapabilities(api);

    const cancel = compatibility.background().referrerPolicies.onObserved(
      () => undefined,
    );

    expect(extraInfoSpec).toEqual(['responseHeaders']);
    cancel();
  });
});
