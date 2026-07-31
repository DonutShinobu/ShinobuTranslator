import { expect, it } from 'vitest';
import type {
  AuthenticationTabNavigation,
  BackgroundExtensionCapabilities,
  DocumentReferrerPolicy,
  JsonValue,
  PermissionChange,
  PermissionRequirement,
  PopupExtensionCapabilities,
  ShortcutTrigger,
} from '../../../apps/extension/src/capabilities/contracts';

export type PopupCapabilityContractDriver = {
  capabilities: PopupExtensionCapabilities;
  storedValue(key: string): unknown;
  rejectNextStorage(error: Error): void;
  openedUrlValues(): readonly string[];
  expectedAuthenticationTabId(): number;
  closedTabIds(): readonly number[];
  makeNextAuthenticationTabCloseUnavailable(): void;
  emitAuthenticationNavigation(navigation: AuthenticationTabNavigation): void;
  emitAuthenticationClosed(tabId: number): void;
  authenticationListenerRemovals(): number;
  emitCommand(trigger: ShortcutTrigger): void;
  commandListenerRemovals(): number;
  shortcutSettingsOpened(): boolean;
  grantRequirement(requirement: PermissionRequirement): void;
  emitPermissionChange(change: PermissionChange): void;
  permissionListenerRemovals(): number;
  expectedResourceUrl(path: string): string;
};

export type PopupBasicCapabilities = Pick<
  PopupExtensionCapabilities,
  'persistentStorage' | 'commands' | 'environment'
>;

export type PopupBasicCapabilityContractDriver = Omit<Pick<
  PopupCapabilityContractDriver,
  | 'capabilities'
  | 'storedValue'
  | 'rejectNextStorage'
  | 'emitCommand'
  | 'commandListenerRemovals'
  | 'shortcutSettingsOpened'
  | 'expectedResourceUrl'
>, 'capabilities'> & {
  capabilities: PopupBasicCapabilities;
};

export function runPopupBasicCapabilityContract(
  createDriver: () => PopupBasicCapabilityContractDriver,
): void {
  it('provides JSON storage success, serialization, and browser-error semantics', async () => {
    const driver = createDriver();

    await expect(driver.capabilities.persistentStorage.read([
      'present',
      'missing',
    ])).resolves.toEqual({
      present: { nested: true },
      missing: undefined,
    });
    await driver.capabilities.persistentStorage.write({
      language: 'zh-CN',
      flags: [true, false],
    });
    expect(driver.storedValue('language')).toBe('zh-CN');
    await driver.capabilities.persistentStorage.remove(['language']);
    expect(driver.storedValue('language')).toBeUndefined();

    await expect(driver.capabilities.persistentStorage.write({
      invalid: new Date('2026-01-01T00:00:00.000Z') as unknown as JsonValue,
    })).rejects.toMatchObject({
      code: 'serialization-failed',
      retryable: false,
    });

    driver.rejectNextStorage(new Error('Bearer top-secret-token'));
    const rejected = driver.capabilities.persistentStorage.read(['present']);
    await expect(rejected).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'persistent-storage',
      operation: 'read',
      code: 'browser-rejected',
      diagnostic: {
        errorName: 'Error',
      },
    });
    await expect(rejected).rejects.not.toThrow('top-secret-token');
  });

  it('normalizes native command behavior and cancellation', async () => {
    const driver = createDriver();
    const triggers: ShortcutTrigger[] = [];
    const cancel = driver.capabilities.commands.onTriggered(
      (trigger) => triggers.push(trigger),
    );

    await expect(driver.capabilities.commands.bindings()).resolves.toEqual([{
      command: 'translate-hover',
      description: 'Translate hovered image',
      shortcut: 'Alt+T',
    }]);
    driver.emitCommand({ command: 'translate-hover', tabId: 4 });
    await driver.capabilities.commands.openSettings();

    expect(triggers).toEqual([{ command: 'translate-hover', tabId: 4 }]);
    expect(driver.shortcutSettingsOpened()).toBe(true);
    cancel();
    cancel();
    expect(driver.commandListenerRemovals()).toBe(1);
  });

  it('provides packaged resource URLs and immutable metadata', () => {
    const driver = createDriver();

    expect(driver.capabilities.environment.metadata).toEqual({
      version: '0.8.1',
    });
    expect(driver.capabilities.environment.resourceUrl('models/detect.onnx')).toBe(
      driver.expectedResourceUrl('models/detect.onnx'),
    );
    expect(Object.isFrozen(driver.capabilities.environment.metadata)).toBe(true);
  });
}

export function runPopupCapabilityContract(
  createDriver: () => PopupCapabilityContractDriver,
): void {
  runPopupBasicCapabilityContract(createDriver);

  it('normalizes authentication-tab lifecycle and idempotent cancellation', async () => {
    const driver = createDriver();
    const navigations: AuthenticationTabNavigation[] = [];
    const closed: number[] = [];
    const tabId = driver.expectedAuthenticationTabId();
    const cancelNavigation = driver.capabilities.authenticationTabs.onNavigation(
      (navigation) => navigations.push(navigation),
    );
    const cancelClosed = driver.capabilities.authenticationTabs.onClosed(
      (tabId) => closed.push(tabId),
    );

    await expect(driver.capabilities.authenticationTabs.open(
      'https://auth.example.test/login',
    )).resolves.toEqual({
      status: 'opened',
      tabId,
    });
    await expect(
      driver.capabilities.authenticationTabs.close(tabId),
    ).resolves.toEqual({ status: 'closed' });
    driver.makeNextAuthenticationTabCloseUnavailable();
    await expect(
      driver.capabilities.authenticationTabs.close(tabId),
    ).resolves.toEqual({ status: 'unavailable' });
    driver.emitAuthenticationNavigation({
      tabId,
      url: 'https://auth.example.test/callback',
    });
    driver.emitAuthenticationClosed(tabId);

    expect(driver.openedUrlValues()).toContain('https://auth.example.test/login');
    expect(driver.closedTabIds()).toEqual([tabId]);
    expect(navigations).toEqual([{
      tabId,
      url: 'https://auth.example.test/callback',
    }]);
    expect(closed).toEqual([tabId]);

    cancelNavigation();
    cancelNavigation();
    cancelClosed();
    cancelClosed();
    expect(driver.authenticationListenerRemovals()).toBe(2);
  });

  it('returns permission decisions and scoped revocation events', async () => {
    const driver = createDriver();
    const requirements: readonly PermissionRequirement[] = [
      { kind: 'authentication-data-use' },
      { kind: 'cookie-access' },
    ];
    const changes: PermissionChange[] = [];
    const cancel = driver.capabilities.permissions.onChanged(
      requirements,
      (change) => changes.push(change),
    );

    await expect(driver.capabilities.permissions.check(requirements)).resolves.toEqual({
      status: 'not-granted',
      missing: [{ kind: 'cookie-access' }],
    });
    await expect(driver.capabilities.permissions.request(requirements)).resolves.toEqual({
      status: 'denied',
      missing: [{ kind: 'cookie-access' }],
    });

    driver.grantRequirement({ kind: 'cookie-access' });
    await expect(driver.capabilities.permissions.check(requirements)).resolves.toEqual({
      status: 'granted',
    });
    driver.emitPermissionChange({
      status: 'revoked',
      requirements: [{ kind: 'cookie-access' }],
    });
    expect(changes).toEqual([{
      status: 'revoked',
      requirements: [{ kind: 'cookie-access' }],
    }]);

    cancel();
    cancel();
    expect(driver.permissionListenerRemovals()).toBe(2);
  });
}

export type BackgroundCapabilityContractDriver = {
  capabilities: BackgroundExtensionCapabilities;
  makeNextTabMessageUnavailable(): void;
  rejectNextTabMessage(): void;
  setCaptureResult(value: string | undefined): void;
  emitMenuSelection(menuId: string, tabId?: number): void;
  menuListenerRemovals(): number;
  grantCookieAccess(): void;
  cookieReadCount(): number;
  emitInstallation(reason: 'install' | 'update' | 'browser_update'): void;
  installationListenerRemovals(): number;
} & NetworkCapabilityContractDriver;

export type NetworkCapabilities = Pick<
  BackgroundExtensionCapabilities,
  'referrerPolicies' | 'requestHeaderOverride'
>;

export type NetworkCapabilityContractDriver = {
  capabilities: NetworkCapabilities;
  emitReferrerPolicy(observation: DocumentReferrerPolicy): void;
  referrerListenerRemovals(): number;
  headerOverrideUpdateCount(): number;
  rejectNextHeaderOverrideUpdate(): void;
};

export type BackgroundBasicCapabilities = Pick<
  BackgroundExtensionCapabilities,
  | 'installation'
  | 'persistentStorage'
  | 'sessionStorage'
  | 'tabMessages'
  | 'visibleTabCapture'
  | 'menus'
>;

export type BackgroundBasicCapabilityContractDriver = Omit<Pick<
  BackgroundCapabilityContractDriver,
  | 'capabilities'
  | 'makeNextTabMessageUnavailable'
  | 'rejectNextTabMessage'
  | 'setCaptureResult'
  | 'emitMenuSelection'
  | 'menuListenerRemovals'
  | 'emitInstallation'
  | 'installationListenerRemovals'
>, 'capabilities'> & {
  capabilities: BackgroundBasicCapabilities;
};

export function runBackgroundBasicCapabilityContract(
  createDriver: () => BackgroundBasicCapabilityContractDriver,
): void {
  it('normalizes tab messaging, capture, and expected unavailable results', async () => {
    const driver = createDriver();

    await expect(driver.capabilities.tabMessages.send(
      { tabId: 9, documentId: 'document-9' },
      { type: 'translate' },
    )).resolves.toEqual({
      status: 'response',
      value: { ok: true },
    });
    driver.makeNextTabMessageUnavailable();
    await expect(driver.capabilities.tabMessages.send(
      { tabId: 9, documentId: 'document-9' },
      { type: 'translate' },
    )).resolves.toEqual({ status: 'unavailable' });
    driver.rejectNextTabMessage();
    await expect(driver.capabilities.tabMessages.send(
      { tabId: 9, documentId: 'document-9' },
      { type: 'translate' },
    )).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'tab-message',
      operation: 'send',
      code: 'browser-rejected',
    });

    await expect(driver.capabilities.visibleTabCapture.capturePng()).resolves.toEqual({
      status: 'unavailable',
    });
    driver.setCaptureResult('data:image/png;base64,AA==');
    await expect(driver.capabilities.visibleTabCapture.capturePng(3)).resolves.toEqual({
      status: 'captured',
      dataUrl: 'data:image/png;base64,AA==',
    });
  });

  it('normalizes native menus and idempotent event cancellation', async () => {
    const driver = createDriver();
    const selections: Array<{ menuId: string; tabId?: number }> = [];
    const cancel = driver.capabilities.menus.onSelected(
      (selection) => selections.push(selection),
    );

    await driver.capabilities.menus.replace([{
      id: 'translate-image',
      title: 'Translate image',
      contexts: ['image'],
    }]);
    driver.emitMenuSelection('translate-image', 4);
    expect(selections).toEqual([{
      menuId: 'translate-image',
      tabId: 4,
    }]);

    cancel();
    cancel();
    expect(driver.menuListenerRemovals()).toBe(1);
  });

  it('normalizes install reasons and idempotent event cancellation', () => {
    const driver = createDriver();
    const reasons: string[] = [];
    const cancel = driver.capabilities.installation.onInstalled(
      ({ reason }) => reasons.push(reason),
    );

    driver.emitInstallation('install');
    driver.emitInstallation('update');
    driver.emitInstallation('browser_update');
    expect(reasons).toEqual(['installed', 'upgraded', 'other']);

    cancel();
    cancel();
    expect(driver.installationListenerRemovals()).toBe(1);
  });

  it('keeps persistent and session storage as distinct available capabilities', async () => {
    const driver = createDriver();

    await expect(driver.capabilities.persistentStorage.write({
      scope: 'persistent',
    })).resolves.toBeUndefined();
    await expect(driver.capabilities.sessionStorage.write({
      scope: 'session',
    })).resolves.toBeUndefined();
  });
}

export function runBackgroundCapabilityContract(
  createDriver: () => BackgroundCapabilityContractDriver,
): void {
  runBackgroundBasicCapabilityContract(createDriver);
  runNetworkCapabilityContract(createDriver);

  it('distinguishes permission-required cookies from an empty cookie result', async () => {
    const driver = createDriver();
    const requirements = [{ kind: 'cookie-access' as const }];

    await expect(driver.capabilities.cookies.read(
      { url: 'https://gemini.google.com/' },
      requirements,
    )).resolves.toEqual({
      status: 'permission-required',
      missing: requirements,
    });
    expect(driver.cookieReadCount()).toBe(0);

    driver.grantCookieAccess();
    await expect(driver.capabilities.cookies.read(
      { url: 'https://gemini.google.com/' },
      requirements,
    )).resolves.toEqual({
      status: 'available',
      cookies: [],
    });
    expect(driver.cookieReadCount()).toBe(1);
  });

}

export function runNetworkCapabilityContract(
  createDriver: () => NetworkCapabilityContractDriver,
): void {
  it('normalizes referrer policy observation and idempotent cancellation', () => {
    const driver = createDriver();
    const observations: DocumentReferrerPolicy[] = [];
    const cancel = driver.capabilities.referrerPolicies.onObserved(
      (observation) => observations.push(observation),
    );
    const observation: DocumentReferrerPolicy = {
      document: {
        documentId: 'document-4',
        tabId: 4,
        frameId: 0,
        url: 'https://example.test/chapter',
      },
      policy: 'strict-origin',
    };

    driver.emitReferrerPolicy(observation);
    expect(observations).toEqual([observation]);
    cancel();
    cancel();
    expect(driver.referrerListenerRemovals()).toBe(1);
  });

  it('uses idempotent header cleanup and permits cleanup retry', async () => {
    const driver = createDriver();
    const lease = await driver.capabilities.requestHeaderOverride.acquire({
      url: 'https://cdn.example.test/image.png',
      headers: [{
        name: 'Referer',
        value: 'https://example.test/',
      }],
    });

    driver.rejectNextHeaderOverrideUpdate();
    await expect(lease.release()).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      code: 'cleanup-failed',
      retryable: true,
    });
    await expect(lease.release()).resolves.toBeUndefined();
    await expect(lease.release()).resolves.toBeUndefined();
    expect(driver.headerOverrideUpdateCount()).toBe(3);
  });

  it('reports header override acquisition failures as structured operation errors', async () => {
    const driver = createDriver();
    driver.rejectNextHeaderOverrideUpdate();

    await expect(driver.capabilities.requestHeaderOverride.acquire({
      url: 'https://cdn.example.test/image.png',
      headers: [{
        name: 'Referer',
        value: 'https://example.test/',
      }],
    })).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'request-header-override',
      operation: 'acquire',
      code: 'browser-rejected',
      retryable: false,
      diagnostic: {
        errorName: 'Error',
      },
    });
  });
}
