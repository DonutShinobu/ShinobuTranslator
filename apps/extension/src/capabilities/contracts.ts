export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CancelSubscription = () => void;

export type ExtensionMessageSource =
  | {
      kind: 'tab-document';
      documentId: string;
      tabId: number;
      windowId?: number;
      frameId: number;
      url?: string;
    }
  | {
      kind: 'extension-document';
      documentId?: string;
      url?: string;
    }
  | {
      kind: 'unknown';
    };

export type MessageResponseResult =
  | {
      status: 'response';
      value: JsonValue;
    }
  | {
      status: 'no-response';
    }
  | {
      status: 'unavailable';
    };

export type RuntimeRequestResult = MessageResponseResult;

export type RuntimeRequestHandler = (
  request: JsonValue,
  source: ExtensionMessageSource,
) => Promise<JsonValue | undefined>;

export interface RuntimeRequestTransport {
  request(request: JsonValue): Promise<RuntimeRequestResult>;
  onRequest(handler: RuntimeRequestHandler): CancelSubscription;
}

export interface RuntimeRequestClient {
  request(request: JsonValue): Promise<RuntimeRequestResult>;
}

export interface RuntimeRequestServer {
  onRequest(handler: RuntimeRequestHandler): CancelSubscription;
}

export type RuntimeChannelDisconnectReason =
  | 'peer-disconnected'
  | 'closed-locally';

export interface RuntimeChannel {
  readonly name: string;
  readonly source: ExtensionMessageSource;
  send(message: JsonValue): Promise<void>;
  onMessage(listener: (message: JsonValue) => void): CancelSubscription;
  onDisconnect(
    listener: (reason: RuntimeChannelDisconnectReason) => void,
  ): CancelSubscription;
  disconnect(): Promise<void>;
}

export interface RuntimeChannelClient {
  open(name: string): Promise<RuntimeChannel>;
}

export interface RuntimeChannelServer {
  onChannel(listener: (channel: RuntimeChannel) => void): CancelSubscription;
}

export interface ExtensionEnvironment {
  readonly metadata: Readonly<{
    version: string;
  }>;
  resourceUrl(path: string): string;
}

export interface ExtensionStorage {
  read(
    keys: readonly string[],
  ): Promise<Readonly<Record<string, JsonValue | undefined>>>;
  write(values: Readonly<Record<string, JsonValue>>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

export type TabDocumentTarget = Readonly<{
  tabId: number;
  documentId: string;
}>;

export type TabMessageResult = MessageResponseResult;

export interface TabMessageTransport {
  send(
    target: TabDocumentTarget,
    message: JsonValue,
  ): Promise<TabMessageResult>;
}

export type VisibleTabCaptureResult =
  | {
      status: 'captured';
      dataUrl: string;
    }
  | {
      status: 'unavailable';
    };

export interface VisibleTabCapture {
  capturePng(windowId?: number): Promise<VisibleTabCaptureResult>;
}

export type AuthenticationTabOpenResult =
  | {
      status: 'opened';
      tabId: number;
    }
  | {
      status: 'unavailable';
    };

export type AuthenticationTabNavigation = Readonly<{
  tabId: number;
  url: string;
}>;

export type AuthenticationTabCloseResult =
  | {
      status: 'closed';
    }
  | {
      status: 'unavailable';
    };

export interface AuthenticationTabLifecycle {
  open(url: string): Promise<AuthenticationTabOpenResult>;
  close(tabId: number): Promise<AuthenticationTabCloseResult>;
  onNavigation(
    listener: (navigation: AuthenticationTabNavigation) => void,
  ): CancelSubscription;
  onClosed(listener: (tabId: number) => void): CancelSubscription;
}

export type NativeMenuContext =
  | 'page'
  | 'selection'
  | 'link'
  | 'image';

export type NativeMenuDeclaration = Readonly<{
  id: string;
  title: string;
  contexts: readonly NativeMenuContext[];
}>;

export type NativeMenuSelection = Readonly<{
  menuId: string;
  tabId?: number;
}>;

export interface NativeMenus {
  replace(items: readonly NativeMenuDeclaration[]): Promise<void>;
  onSelected(
    listener: (selection: NativeMenuSelection) => void,
  ): CancelSubscription;
}

export type ShortcutBinding = Readonly<{
  command: string;
  description?: string;
  shortcut?: string;
}>;

export type ShortcutTrigger = Readonly<{
  command: string;
  tabId?: number;
}>;

export interface NativeCommands {
  bindings(): Promise<readonly ShortcutBinding[]>;
  onTriggered(
    listener: (trigger: ShortcutTrigger) => void,
  ): CancelSubscription;
  openSettings(): Promise<void>;
}

export type PermissionRequirement =
  | Readonly<{
      kind: 'cookie-access';
    }>
  | Readonly<{
      kind: 'authentication-data-use';
    }>
  | Readonly<{
      kind: 'target-origin';
      origin: string;
    }>;

export type PermissionCheckResult =
  | {
      status: 'granted';
    }
  | {
      status: 'not-granted';
      missing: readonly PermissionRequirement[];
    };

export type PermissionRequestResult =
  | {
      status: 'granted';
    }
  | {
      status: 'denied';
      missing: readonly PermissionRequirement[];
    };

export type PermissionChange = Readonly<{
  status: 'granted' | 'revoked';
  requirements: readonly PermissionRequirement[];
}>;

export interface ExtensionPermissions {
  check(
    requirements: readonly PermissionRequirement[],
  ): Promise<PermissionCheckResult>;
  request(
    requirements: readonly PermissionRequirement[],
  ): Promise<PermissionRequestResult>;
  onChanged(
    requirements: readonly PermissionRequirement[],
    listener: (change: PermissionChange) => void,
  ): CancelSubscription;
}

export type ExtensionCookie = Readonly<{
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
}>;

export type CookieQuery = Readonly<{
  url?: string;
  domain?: string;
  name?: string;
}>;

export type CookieReadResult =
  | {
      status: 'available';
      cookies: readonly ExtensionCookie[];
    }
  | {
      status: 'permission-required';
      missing: readonly PermissionRequirement[];
    };

export interface ExtensionCookies {
  read(
    query: CookieQuery,
    requirements: readonly PermissionRequirement[],
  ): Promise<CookieReadResult>;
}

export type DocumentIdentity = Readonly<{
  documentId: string;
  tabId: number;
  frameId: number;
  url: string;
}>;

export type DocumentReferrerPolicy = Readonly<{
  document: DocumentIdentity;
  policy?: string;
}>;

export interface DocumentReferrerPolicyObserver {
  onObserved(
    listener: (observation: DocumentReferrerPolicy) => void,
  ): CancelSubscription;
}

export type RequestHeader = Readonly<{
  name: string;
  value: string;
}>;

export type RequestHeaderOverrideRequest = Readonly<{
  url: string;
  headers: readonly RequestHeader[];
}>;

export interface RequestHeaderOverrideLease {
  release(): Promise<void>;
}

export interface RequestHeaderOverride {
  acquire(
    request: RequestHeaderOverrideRequest,
  ): Promise<RequestHeaderOverrideLease>;
}

export interface BackgroundExtensionCapabilities {
  readonly runtimeRequests: RuntimeRequestServer;
  readonly runtimeChannels: RuntimeChannelServer;
  readonly persistentStorage: ExtensionStorage;
  readonly sessionStorage: ExtensionStorage;
  readonly tabMessages: TabMessageTransport;
  readonly visibleTabCapture: VisibleTabCapture;
  readonly authenticationTabs: AuthenticationTabLifecycle;
  readonly menus: NativeMenus;
  readonly commands: NativeCommands;
  readonly permissions: ExtensionPermissions;
  readonly cookies: ExtensionCookies;
  readonly referrerPolicies: DocumentReferrerPolicyObserver;
  readonly requestHeaderOverride: RequestHeaderOverride;
  readonly environment: ExtensionEnvironment;
}

export interface ContentExtensionCapabilities {
  readonly runtimeRequests: RuntimeRequestTransport;
  readonly runtimeChannels: RuntimeChannelClient;
  readonly environment: ExtensionEnvironment;
}

export interface PopupExtensionCapabilities {
  readonly runtimeRequests: RuntimeRequestClient;
  readonly persistentStorage: ExtensionStorage;
  readonly authenticationTabs: AuthenticationTabLifecycle;
  readonly commands: NativeCommands;
  readonly permissions: ExtensionPermissions;
  readonly environment: ExtensionEnvironment;
}

export interface PipelineHostExtensionCapabilities {
  readonly runtimeRequests: RuntimeRequestClient;
  readonly runtimeChannels: RuntimeChannelClient;
  readonly environment: ExtensionEnvironment;
}

export interface ExtensionCapabilityAdapter {
  background(): BackgroundExtensionCapabilities;
  content(): ContentExtensionCapabilities;
  popup(): PopupExtensionCapabilities;
  pipelineHost(): PipelineHostExtensionCapabilities;
}
