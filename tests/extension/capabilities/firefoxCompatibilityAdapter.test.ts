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
});
