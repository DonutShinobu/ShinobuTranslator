import { describe, expect, it } from 'vitest';
import {
  createFirefoxExtensionAdapter,
} from '../../../apps/extension/src/capabilities/firefoxAdapter';
import type {
  BackgroundExtensionCapabilities,
  PopupExtensionCapabilities,
} from '../../../apps/extension/src/capabilities/contracts';
import type {
  ExtensionCompatibilityCapabilities,
} from '../../../apps/extension/src/capabilities/compatibility';
import { createListenerEvent } from './listenerEvent.fixture';

function createBrowserApi() {
  const port = {
    name: 'pipeline',
    postMessage: () => undefined,
    disconnect: () => undefined,
    onMessage: createListenerEvent<unknown>().raw,
    onDisconnect: createListenerEvent<void>().raw,
  };
  const storage = {
    async get(): Promise<Record<string, unknown>> {
      return {};
    },
    async set(): Promise<void> {},
    async remove(): Promise<void> {},
  };
  return {
    runtime: {
      id: 'firefox-extension-id',
      async sendMessage(): Promise<unknown> {
        return undefined;
      },
      connect: () => port,
      getManifest: () => ({ version: '0.8.1' }),
      getURL: (path: string) => `moz-extension://firefox-extension-id/${path}`,
      onMessage: createListenerEvent<
        (request: unknown, sender: unknown) => Promise<unknown> | undefined
      >().raw,
      onConnect: createListenerEvent<unknown>().raw,
      onInstalled: createListenerEvent<{
        reason?: string;
        previousVersion?: string;
      }>().raw,
    },
    storage: {
      local: storage,
      session: storage,
    },
    tabs: {
      async sendMessage(): Promise<unknown> {
        return undefined;
      },
      async captureVisibleTab(): Promise<string | undefined> {
        return undefined;
      },
      async create(): Promise<{ id?: number }> {
        return { id: 17 };
      },
      async remove(): Promise<void> {},
      onUpdated: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
      onRemoved: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    commands: {
      async getAll(): Promise<[]> {
        return [];
      },
      async openShortcutSettings(): Promise<void> {},
      onCommand: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    menus: {
      async removeAll(): Promise<void> {},
      create: () => 'menu',
      onClicked: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
  };
}

function createCompatibilityAdapter() {
  const permissions = { source: 'compatibility-permissions' };
  const cookies = { source: 'compatibility-cookies' };
  const referrerPolicies = { source: 'compatibility-referrer' };
  const requestHeaderOverride = { source: 'compatibility-header-override' };
  const background = {
    permissions,
    cookies,
    referrerPolicies,
    requestHeaderOverride,
  } as unknown as BackgroundExtensionCapabilities;
  const popup = {
    permissions,
  } as unknown as PopupExtensionCapabilities;
  const adapter = {
    background: () => background,
    popup: () => popup,
  } satisfies ExtensionCompatibilityCapabilities;
  return {
    adapter,
    background,
    popup,
  };
}

describe('Firefox extension adapter composition', () => {
  it('owns basic Firefox capabilities and preserves downstream compatibility seams', () => {
    const compatibility = createCompatibilityAdapter();
    const adapter = createFirefoxExtensionAdapter(
      createBrowserApi(),
      compatibility.adapter,
    );

    const background = adapter.background();
    expect(background.permissions).toBe(compatibility.background.permissions);
    expect(background.cookies).toBe(compatibility.background.cookies);
    expect(background.referrerPolicies).toBe(
      compatibility.background.referrerPolicies,
    );
    expect(background.requestHeaderOverride).toBe(
      compatibility.background.requestHeaderOverride,
    );
    expect(background.environment.resourceUrl('popup.html')).toBe(
      'moz-extension://firefox-extension-id/popup.html',
    );

    const popup = adapter.popup();
    expect(popup.permissions).toBe(compatibility.popup.permissions);
    expect(popup.environment.resourceUrl('popup.html')).toBe(
      'moz-extension://firefox-extension-id/popup.html',
    );

    expect(adapter.content().environment.resourceUrl('content.js')).toBe(
      'moz-extension://firefox-extension-id/content.js',
    );
    expect(adapter.pipelineHost().environment.resourceUrl('worker.js')).toBe(
      'moz-extension://firefox-extension-id/worker.js',
    );
  });
});
