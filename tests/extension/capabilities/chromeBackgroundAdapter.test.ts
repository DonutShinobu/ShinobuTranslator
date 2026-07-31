import { describe, expect, it, vi } from 'vitest';
import {
  createChromeExtensionAdapter,
} from '../../../apps/extension/src/capabilities/chromeAdapter';
import {
  requestHeaderOverride,
} from '../../../apps/extension/src/capabilities/chromeNetwork';
import {
  createAuthenticationAccess,
} from '../../../apps/extension/src/capabilities/authentication';
import type {
  DocumentReferrerPolicy,
  PermissionChange,
  RuntimeChannel,
} from '../../../apps/extension/src/capabilities/contracts';
import {
  ExtensionContractError,
} from '../../../apps/extension/src/capabilities/errors';
import { createListenerEvent } from './listenerEvent.fixture';
import {
  runBackgroundCapabilityContract,
} from './extensionAdapterContract.fixture';
import {
  runRuntimeServerAdapterContract,
} from './runtimeAdapterContract.fixture';

type RawPort = {
  name: string;
  sender?: Record<string, unknown>;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
};

function storageArea() {
  return {
    get(_keys: string[], callback: (values: Record<string, unknown>) => void): void {
      callback({});
    },
    set(_values: Record<string, unknown>, callback: () => void): void {
      callback();
    },
    remove(_keys: string[], callback: () => void): void {
      callback();
    },
  };
}

function createBackgroundHarness() {
  type RequestListener = (
    request: unknown,
    sender: Record<string, unknown>,
    sendResponse: (response: unknown) => void,
  ) => boolean | void;
  const requestListeners = new Set<RequestListener>();
  const onConnect = createListenerEvent<RawPort>();
  const onClicked = createListenerEvent<[
    { menuItemId?: string | number },
    { id?: number } | undefined,
  ]>();
  type MenuListener = (
    info: { menuItemId?: string | number },
    tab?: { id?: number },
  ) => void;
  const menuListenerWrappers = new Map<
    MenuListener,
    (value: [{ menuItemId?: string | number }, { id?: number } | undefined]) => void
  >();
  const onCommand = createListenerEvent<[string, { id?: number } | undefined]>();
  const onInstalled = createListenerEvent<{
    reason?: string;
    previousVersion?: string;
  }>();
  const permissionAdded = createListenerEvent<Record<string, unknown>>();
  const permissionRemoved = createListenerEvent<Record<string, unknown>>();
  const headersListeners = new Set<(details: Record<string, unknown>) => void>();
  let headerListenerRemovals = 0;
  let cookieAccessGranted = false;
  let cookieReads = 0;
  const cookieQueries: Array<Record<string, unknown>> = [];
  const grantedOrigins = new Set<string>();
  let permissionRequestCount = 0;
  let captureResponse: string | undefined;
  let tabMessageFailure: 'unavailable' | 'rejected' | undefined;
  let rejectedDnrUpdates = 0;
  const dynamicDnrUpdates: Array<Record<string, unknown>> = [];
  const sessionDnrUpdates: Array<Record<string, unknown>> = [];
  const sentTabMessages: Array<Record<string, unknown>> = [];
  const createdMenus: Array<Record<string, unknown>> = [];

  const runtime = {
    id: 'extension-id',
    lastError: undefined as { message?: string } | undefined,
    getManifest: () => ({ version: '0.8.1' }),
    getURL: (path: string) => `chrome-extension://extension-id/${path}`,
    onMessage: {
      addListener(
        listener: RequestListener,
      ): void {
        requestListeners.add(listener);
      },
      removeListener(
        listener: RequestListener,
      ): void {
        requestListeners.delete(listener);
      },
    },
    onConnect: onConnect.raw,
    onInstalled: onInstalled.raw,
  };
  const port: RawPort = {
    name: 'pipeline-host',
    postMessage: () => undefined,
    disconnect: () => undefined,
    onMessage: {
      addListener: () => undefined,
      removeListener: () => undefined,
    },
    onDisconnect: {
      addListener: () => undefined,
      removeListener: () => undefined,
    },
  };
  const api = {
    runtime,
    storage: {
      local: storageArea(),
      session: storageArea(),
    },
    tabs: {
      sendMessage(
        tabId: number,
        message: unknown,
        optionsOrCallback: { documentId: string } | ((response: unknown) => void),
        maybeCallback?: (response: unknown) => void,
      ): void {
        const options = typeof optionsOrCallback === 'function'
          ? undefined
          : optionsOrCallback;
        const callback = typeof optionsOrCallback === 'function'
          ? optionsOrCallback
          : maybeCallback!;
        sentTabMessages.push({
          tabId,
          message,
          ...(options ? { options } : {}),
        });
        if (tabMessageFailure) {
          runtime.lastError = {
            message: tabMessageFailure === 'unavailable'
              ? 'No document with id document-9 in tab with id 9'
              : 'The browser rejected the operation.',
          };
          callback(undefined);
          runtime.lastError = undefined;
          tabMessageFailure = undefined;
          return;
        }
        callback({ ok: true });
      },
      captureVisibleTab(
        _windowId: number | undefined,
        _options: { format: string },
        callback: (value?: string) => void,
      ): void {
        callback(captureResponse);
      },
      create(
        _details: Record<string, unknown>,
        callback: (tab: { id?: number }) => void,
      ): void {
        callback({ id: 23 });
      },
      remove(_tabId: number, callback: () => void): void {
        callback();
      },
      onUpdated: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
      onRemoved: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    contextMenus: {
      removeAll(callback: () => void): void {
        callback();
      },
      create(_item: Record<string, unknown>, callback: () => void): void {
        createdMenus.push(_item);
        callback();
      },
      onClicked: {
        addListener(
          listener: MenuListener,
        ): void {
          const wrapper = (
            [info, tab]: [
              { menuItemId?: string | number },
              { id?: number } | undefined,
            ],
          ): void => listener(info, tab);
          menuListenerWrappers.set(listener, wrapper);
          onClicked.raw.addListener(wrapper);
        },
        removeListener(listener: MenuListener): void {
          const wrapper = menuListenerWrappers.get(listener);
          if (!wrapper) return;
          menuListenerWrappers.delete(listener);
          onClicked.raw.removeListener(wrapper);
        },
      },
    },
    commands: {
      getAll(callback: (commands: Array<Record<string, unknown>>) => void): void {
        callback([]);
      },
      onCommand: {
        addListener(
          listener: (command: string, tab?: { id?: number }) => void,
        ): void {
          onCommand.raw.addListener(([command, tab]) => listener(command, tab));
        },
        removeListener: () => undefined,
      },
    },
    permissions: {
      contains(
        details: { permissions?: string[]; origins?: string[] },
        callback: (granted: boolean) => void,
      ): void {
        callback(
          (!details.permissions?.includes('cookies') || cookieAccessGranted)
          && (details.origins?.every((origin) => grantedOrigins.has(origin)) ?? true),
        );
      },
      request(
        details: Record<string, unknown>,
        callback: (granted: boolean) => void,
      ): void {
        permissionRequestCount += 1;
        const requestedPermissions = Array.isArray(details.permissions)
          ? details.permissions
          : [];
        const requestedOrigins = Array.isArray(details.origins)
          ? details.origins
          : [];
        callback(
          (!requestedPermissions.includes('cookies') || cookieAccessGranted)
          && requestedOrigins.every(
            (origin) => typeof origin === 'string' && grantedOrigins.has(origin),
          ),
        );
      },
      onAdded: permissionAdded.raw,
      onRemoved: permissionRemoved.raw,
    },
    cookies: {
      getAll(
        query: Record<string, unknown>,
        callback: (cookies: Array<Record<string, unknown>>) => void,
      ): void {
        cookieReads += 1;
        cookieQueries.push(query);
        callback([]);
      },
    },
    webRequest: {
      onHeadersReceived: {
        addListener(
          listener: (details: Record<string, unknown>) => void,
          _filter: Record<string, unknown>,
          _extra: string[],
        ): void {
          headersListeners.add(listener);
        },
        removeListener(listener: (details: Record<string, unknown>) => void): void {
          if (headersListeners.delete(listener)) headerListenerRemovals += 1;
        },
      },
    },
    declarativeNetRequest: {
      async updateDynamicRules(update: Record<string, unknown>): Promise<void> {
        dynamicDnrUpdates.push(update);
        if (rejectedDnrUpdates > 0) {
          rejectedDnrUpdates -= 1;
          throw new Error('api-key=top-secret');
        }
      },
      async updateSessionRules(update: Record<string, unknown>): Promise<void> {
        sessionDnrUpdates.push(update);
        if (rejectedDnrUpdates > 0) {
          rejectedDnrUpdates -= 1;
          throw new Error('api-key=top-secret');
        }
      },
    },
  };

  const background = createChromeExtensionAdapter(api).background();
  const authentication = createAuthenticationAccess({
    permissions: background.permissions,
    cookies: background.cookies,
  });
  return {
    background,
    authentication,
    capabilities: background,
    onConnect,
    port,
    headersListeners,
    dnrUpdates: sessionDnrUpdates,
    dynamicDnrUpdates,
    sessionDnrUpdates,
    sentTabMessages,
    createdMenus,
    onClicked,
    emitInstallation(reason: 'install' | 'update' | 'browser_update' | 'chrome_update') {
      onInstalled.emit({ reason });
    },
    installationListenerRemovals() {
      return onInstalled.removals();
    },
    grantCookieAccess() {
      cookieAccessGranted = true;
    },
    grantTargetOrigin(origin: string) {
      grantedOrigins.add(origin);
    },
    permissionRequestCount() {
      return permissionRequestCount;
    },
    emitPermissionChange(change: PermissionChange) {
      const details = {
        permissions: change.requirements.flatMap(
          (requirement) => requirement.kind === 'cookie-access'
            ? ['cookies']
            : [],
        ),
        origins: change.requirements.flatMap(
          (requirement) => requirement.kind === 'target-origin'
            ? [`${requirement.origin}/*`]
            : [],
        ),
      };
      if (change.status === 'granted') {
        permissionAdded.emit(details);
      } else {
        permissionRemoved.emit(details);
      }
    },
    cookieReads() {
      return cookieReads;
    },
    cookieQueries() {
      return cookieQueries;
    },
    captureWith(value: string | undefined) {
      captureResponse = value;
    },
    makeNextTabMessageUnavailable() {
      tabMessageFailure = 'unavailable';
    },
    setCaptureResult(value: string | undefined) {
      captureResponse = value;
    },
    emitMenuSelection(menuId: string, tabId?: number) {
      onClicked.emit([
        { menuItemId: menuId },
        tabId === undefined ? undefined : { id: tabId },
      ]);
    },
    menuListenerRemovals() {
      return onClicked.removals();
    },
    cookieReadCount() {
      return cookieReads;
    },
    emitReferrerPolicy(observation: DocumentReferrerPolicy) {
      for (const listener of headersListeners) {
        listener({
          documentId: observation.document.documentId,
          tabId: observation.document.tabId,
          frameId: observation.document.frameId,
          url: observation.document.url,
          responseHeaders: observation.policy
            ? [{ name: 'Referrer-Policy', value: observation.policy }]
            : [],
        });
      }
    },
    referrerListenerRemovals() {
      return headerListenerRemovals;
    },
    headerOverrideUpdateCount() {
      return sessionDnrUpdates.filter((update) => {
        const addRules = update.addRules;
        const removeRuleIds = update.removeRuleIds;
        return (
          Array.isArray(addRules)
          && addRules.some((rule) => (
            typeof rule === 'object'
            && rule !== null
            && typeof (rule as { id?: unknown }).id === 'number'
            && (rule as { id: number }).id >= 1_000_000
          ))
        ) || (
          Array.isArray(removeRuleIds)
          && removeRuleIds.some((id) => typeof id === 'number' && id >= 1_000_000)
        );
      }).length;
    },
    rejectNextHeaderOverrideUpdate() {
      rejectedDnrUpdates += 1;
    },
    rejectNextTabMessage() {
      tabMessageFailure = 'rejected';
    },
    rejectNextDnrUpdate() {
      rejectedDnrUpdates += 1;
    },
    headerListenerRemovals() {
      return headerListenerRemovals;
    },
  };
}

describe('Chrome background capability adapter', () => {
  runBackgroundCapabilityContract(createBackgroundHarness);
  runRuntimeServerAdapterContract(() => {
    const harness = createBackgroundHarness();
    return {
      capabilities: harness.background,
      emitChannel() {
        harness.onConnect.emit(harness.port);
      },
      removedChannelListeners() {
        return harness.onConnect.removals();
      },
    };
  });

  it('fails startup when session storage is unavailable instead of falling back', () => {
    const runtime = {
      getManifest: () => ({ version: '0.8.1' }),
      getURL: (path: string) => path,
      onMessage: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
      onConnect: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    };

    expect(() => createChromeExtensionAdapter({
      runtime,
      storage: {
        local: storageArea(),
      },
    }).background()).toThrow(expect.objectContaining({
      name: 'ExtensionContractError',
      capability: 'session-storage',
      code: 'context-unavailable',
    }));
    expect(() => createChromeExtensionAdapter({
      runtime,
      storage: {
        local: storageArea(),
      },
    }).background()).toThrow(ExtensionContractError);
  });

  it('uses document-scoped tab messages and explicit capture results', async () => {
    const harness = createBackgroundHarness();

    await expect(harness.background.tabMessages.send(
      { tabId: 9, documentId: 'document-9' },
      { type: 'translate' },
    )).resolves.toEqual({
      status: 'response',
      value: { ok: true },
    });
    expect(harness.sentTabMessages).toEqual([{
      tabId: 9,
      message: { type: 'translate' },
      options: { documentId: 'document-9' },
    }]);
    await expect(harness.background.tabMessages.send(
      { tabId: 10 },
      { type: 'translate-current-document' },
    )).resolves.toEqual({
      status: 'response',
      value: { ok: true },
    });
    expect(harness.sentTabMessages.at(-1)).toEqual({
      tabId: 10,
      message: { type: 'translate-current-document' },
    });
    harness.makeNextTabMessageUnavailable();
    await expect(harness.background.tabMessages.send(
      { tabId: 9, documentId: 'document-9' },
      { type: 'translate' },
    )).resolves.toEqual({
      status: 'unavailable',
    });

    await expect(harness.background.visibleTabCapture.capturePng()).resolves.toEqual({
      status: 'unavailable',
    });
    harness.captureWith('data:image/png;base64,AA==');
    await expect(harness.background.visibleTabCapture.capturePng(3)).resolves.toEqual({
      status: 'captured',
      dataUrl: 'data:image/png;base64,AA==',
    });
  });

  it('keeps unexpected tab messaging failures as operation errors', async () => {
    const harness = createBackgroundHarness();
    harness.rejectNextTabMessage();

    await expect(harness.background.tabMessages.send(
      { tabId: 9, documentId: 'document-9' },
      { type: 'translate' },
    )).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'tab-message',
      operation: 'send',
      code: 'browser-rejected',
      diagnostic: {
        errorName: 'Error',
      },
    });
  });

  it('normalizes native menu declaration and selection behavior', async () => {
    const harness = createBackgroundHarness();
    const selections: Array<{ menuId: string; tabId?: number }> = [];
    const cancel = harness.background.menus.onSelected(
      (selection) => selections.push(selection),
    );

    await harness.background.menus.replace([{
      id: 'translate-image',
      title: 'Translate image',
      contexts: ['image'],
    }]);
    harness.onClicked.emit([
      { menuItemId: 'translate-image' },
      { id: 4 },
    ]);

    expect(harness.createdMenus).toEqual([{
      id: 'translate-image',
      title: 'Translate image',
      contexts: ['image'],
    }]);
    expect(selections).toEqual([{
      menuId: 'translate-image',
      tabId: 4,
    }]);
    cancel();
  });

  it('normalizes install and upgrade events without exposing Chrome reasons', () => {
    const harness = createBackgroundHarness();
    const changes: string[] = [];
    const cancel = harness.background.installation.onInstalled(
      ({ reason }) => changes.push(reason),
    );

    harness.emitInstallation('install');
    harness.emitInstallation('update');
    harness.emitInstallation('chrome_update');

    expect(changes).toEqual(['installed', 'upgraded', 'other']);
    cancel();
  });

  it('rechecks permission before fixed-scope Gemini cookie reads', async () => {
    const harness = createBackgroundHarness();

    await expect(harness.authentication.readGeminiAppCookies()).resolves.toEqual({
      status: 'permission-required',
      missing: [{ kind: 'cookie-access' }],
    });
    expect(harness.cookieReads()).toBe(0);

    harness.grantCookieAccess();
    await expect(harness.authentication.readGeminiAppCookies()).resolves.toEqual({
      status: 'available',
      cookies: [],
    });
    await expect(harness.authentication.readGoogleAccountsCookies()).resolves.toEqual({
      status: 'available',
      cookies: [],
    });
    expect(harness.cookieReads()).toBe(2);
    expect(harness.cookieQueries()).toEqual([
      { url: 'https://gemini.google.com/' },
      { url: 'https://accounts.google.com/' },
    ]);
  });

  it('keeps Chrome credential modes distinct without requesting during initialization', async () => {
    const harness = createBackgroundHarness();

    expect(harness.permissionRequestCount()).toBe(0);
    await expect(harness.authentication.check({
      kind: 'api-key',
    })).resolves.toEqual({ status: 'granted' });
    await expect(harness.authentication.check({
      kind: 'openai-oauth',
    })).resolves.toEqual({ status: 'granted' });
    await expect(harness.authentication.check({
      kind: 'gemini-cookie',
    })).resolves.toEqual({
      status: 'not-granted',
      missing: [{ kind: 'cookie-access' }],
    });

    await expect(harness.authentication.request({
      kind: 'gemini-cookie',
    })).resolves.toEqual({
      status: 'denied',
      missing: [{ kind: 'cookie-access' }],
    });
    expect(harness.permissionRequestCount()).toBe(1);

    harness.grantCookieAccess();
    await expect(harness.authentication.request({
      kind: 'gemini-cookie',
    })).resolves.toEqual({ status: 'granted' });
    expect(harness.permissionRequestCount()).toBe(1);
  });

  it('normalizes custom endpoint origins and reports scoped revocation', async () => {
    const harness = createBackgroundHarness();
    const changes: PermissionChange[] = [];
    const target = {
      kind: 'api-key' as const,
      targetEndpoint: 'https://CUSTOM.example:443/v1/chat/completions',
    };
    const cancel = harness.authentication.onChanged(
      target,
      (change) => changes.push(change),
    );

    await expect(harness.authentication.request(target)).resolves.toEqual({
      status: 'denied',
      missing: [{
        kind: 'target-origin',
        origin: 'https://custom.example',
      }],
    });
    expect(harness.permissionRequestCount()).toBe(1);

    harness.grantTargetOrigin('https://custom.example/*');
    await expect(harness.authentication.check(target)).resolves.toEqual({
      status: 'granted',
    });
    harness.emitPermissionChange({
      status: 'revoked',
      requirements: [{
        kind: 'target-origin',
        origin: 'https://custom.example',
      }],
    });
    expect(changes).toEqual([{
      status: 'revoked',
      requirements: [{
        kind: 'target-origin',
        origin: 'https://custom.example',
      }],
    }]);
    cancel();
  });

  it('normalizes document referrer policy observations and cancellation', () => {
    const harness = createBackgroundHarness();
    const observations: DocumentReferrerPolicy[] = [];
    const cancel = harness.background.referrerPolicies.onObserved(
      (observation) => observations.push(observation),
    );

    for (const listener of harness.headersListeners) {
      listener({
        documentId: 'document-4',
        tabId: 4,
        frameId: 0,
        url: 'https://example.test/chapter',
        responseHeaders: [
          {
            name: 'Referrer-Policy',
            value: 'origin',
          },
          {
            name: 'referrer-policy',
            value: 'strict-origin',
          },
        ],
      });
    }
    expect(observations).toEqual([{
      document: {
        documentId: 'document-4',
        tabId: 4,
        frameId: 0,
        url: 'https://example.test/chapter',
      },
      policy: 'origin, strict-origin',
    }]);

    for (const listener of harness.headersListeners) {
      listener({
        tabId: 5,
        frameId: 0,
        url: 'https://example.test/next-chapter',
        responseHeaders: [{
          name: 'Referrer-Policy',
          value: 'unsafe-url',
        }],
      });
    }
    expect(observations.at(-1)).toEqual({
      document: {
        documentId: 'synthetic-frame:5:0',
        tabId: 5,
        frameId: 0,
        url: 'https://example.test/next-chapter',
      },
      policy: 'unsafe-url',
    });

    cancel();
    cancel();
    expect(harness.headerListenerRemovals()).toBe(1);
  });

  it('uses idempotent named-channel and header-override cleanup', async () => {
    const harness = createBackgroundHarness();
    const channels: RuntimeChannel[] = [];
    const cancelChannels = harness.background.runtimeChannels.onChannel(
      (channel) => channels.push(channel),
    );
    harness.onConnect.emit(harness.port);
    expect(channels.map((channel) => channel.name)).toEqual(['pipeline-host']);
    cancelChannels();
    cancelChannels();
    expect(harness.onConnect.removals()).toBe(1);

    const lease = await harness.background.requestHeaderOverride.acquire({
      url: 'https://cdn.example.test/image.png',
      headers: [{
        name: 'Referer',
        value: 'https://example.test/',
      }],
    });
    await lease.release();
    await lease.release();

    const overrideUpdates = harness.dnrUpdates.filter((update) => (
      (update.removeRuleIds as number[]).some((id) => id >= 1_000_000)
    ));
    expect(overrideUpdates).toHaveLength(2);
    expect(overrideUpdates[0]).toMatchObject({
      removeRuleIds: [1_000_000],
    });
    expect(overrideUpdates[1]).toMatchObject({
      addRules: [],
    });
  });

  it('cleans legacy dynamic and session header rules during adapter startup', async () => {
    const harness = createBackgroundHarness();

    await vi.waitFor(() => {
      expect(harness.dynamicDnrUpdates).toContainEqual({
        removeRuleIds: [1],
        addRules: [],
      });
      expect(harness.sessionDnrUpdates).toContainEqual({
        removeRuleIds: [2],
        addRules: [],
      });
    });
  });

  it('keeps session rule selection and native matching details inside the adapter', async () => {
    const harness = createBackgroundHarness();
    const lease = await harness.background.requestHeaderOverride.acquire({
      url: 'https://cdn.example.test/image.png?size=original',
      headers: [{
        name: 'Referer',
        value: 'https://reader.example.test/chapter',
      }],
    });

    expect(harness.dynamicDnrUpdates).toContainEqual({
      removeRuleIds: [1],
      addRules: [],
    });
    expect(harness.sessionDnrUpdates).toContainEqual({
      removeRuleIds: [2],
      addRules: [],
    });
    expect(harness.sessionDnrUpdates).toContainEqual({
      removeRuleIds: [1_000_000],
      addRules: [{
        id: 1_000_000,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{
            header: 'Referer',
            operation: 'set',
            value: 'https://reader.example.test/chapter',
          }],
        },
        condition: {
          initiatorDomains: ['extension-id'],
          requestDomains: ['cdn.example.test'],
          requestMethods: ['get'],
          resourceTypes: ['xmlhttprequest'],
          tabIds: [-1],
          urlFilter: 'https://cdn.example.test/image.png?size=original',
        },
      }],
    });

    await lease.release();
    expect(harness.sessionDnrUpdates.at(-1)).toEqual({
      removeRuleIds: [1_000_000],
      addRules: [],
    });
  });

  it('allows a failed header-override cleanup to be retried', async () => {
    const harness = createBackgroundHarness();
    const lease = await harness.background.requestHeaderOverride.acquire({
      url: 'https://cdn.example.test/image.png',
      headers: [{
        name: 'Referer',
        value: 'https://example.test/',
      }],
    });
    harness.rejectNextDnrUpdate();

    await expect(lease.release()).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      code: 'cleanup-failed',
      retryable: true,
      diagnostic: {
        errorName: 'Error',
      },
    });
    await expect(lease.release()).resolves.toBeUndefined();

    const overrideUpdates = harness.dnrUpdates.filter((update) => (
      (update.removeRuleIds as number[]).some((id) => id >= 1_000_000)
    ));
    expect(overrideUpdates).toHaveLength(3);
  });

  it('serializes overlapping header-override lease lifetimes', async () => {
    let updateCount = 0;
    let activeUpdates = 0;
    let maximumActiveUpdates = 0;
    const override = requestHeaderOverride({
      async updateDynamicRules(): Promise<void> {},
      async updateSessionRules(): Promise<void> {
        updateCount += 1;
        activeUpdates += 1;
        maximumActiveUpdates = Math.max(maximumActiveUpdates, activeUpdates);
        try {
          await Promise.resolve();
        } finally {
          activeUpdates -= 1;
        }
      },
    }, 'extension-id');

    const firstLease = override.acquire({
      url: 'https://cdn.example.test/same-image.png',
      headers: [{ name: 'Referer', value: 'https://first.example.test/' }],
    });
    const secondLease = override.acquire({
      url: 'https://cdn.example.test/same-image.png',
      headers: [{ name: 'Referer', value: 'https://second.example.test/' }],
    });

    const acquired: string[] = [];
    void firstLease.then(() => acquired.push('first'));
    void secondLease.then(() => acquired.push('second'));
    const acquiredFirstLease = await firstLease;
    await vi.waitFor(() => expect(acquired).toEqual(['first']));
    expect(updateCount).toBe(2);

    await acquiredFirstLease.release();
    const acquiredSecondLease = await secondLease;
    expect(acquired).toEqual(['first', 'second']);
    await acquiredSecondLease.release();

    expect(updateCount).toBe(5);
    expect(maximumActiveUpdates).toBe(1);
  });

  it('reports a legacy cleanup failure before installing a new override', async () => {
    const override = requestHeaderOverride({
      async updateDynamicRules(): Promise<void> {
        throw new Error('api-key=top-secret');
      },
      async updateSessionRules(): Promise<void> {},
    }, 'extension-id');

    await expect(override.acquire({
      url: 'https://cdn.example.test/image.png',
      headers: [{ name: 'Referer', value: 'https://reader.example.test/' }],
    })).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'request-header-override',
      operation: 'acquire',
      code: 'cleanup-failed',
      retryable: true,
      diagnostic: {
        errorName: 'Error',
      },
    });
  });

  it('retries a transient legacy cleanup failure on the first acquisition', async () => {
    let dynamicCleanupAttempts = 0;
    const override = requestHeaderOverride({
      async updateDynamicRules(): Promise<void> {
        dynamicCleanupAttempts += 1;
        if (dynamicCleanupAttempts === 1) {
          throw new Error('transient browser failure');
        }
      },
      async updateSessionRules(): Promise<void> {},
    }, 'extension-id');

    const lease = await override.acquire({
      url: 'https://cdn.example.test/image.png',
      headers: [{ name: 'Referer', value: 'https://reader.example.test/' }],
    });
    expect(dynamicCleanupAttempts).toBe(2);
    await lease.release();
  });
});
