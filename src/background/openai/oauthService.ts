import type {
  AuthenticationTabLifecycle,
  ExtensionStorage,
} from "../../../apps/extension/src/capabilities/contracts";
import {
  isAuthenticationPermissionRequired,
  type AuthenticationAccess,
  type AuthenticationPermissionRequired,
} from "../../../apps/extension/src/capabilities/authentication";
import {
  buildOpenAiAuthorizeUrl,
  createOpenAiOAuthCodeChallenge,
  createOpenAiOAuthRandomString,
  isOpenAiOAuthExpired,
  isOpenAiOAuthRefreshSuperseded,
  isPermanentOpenAiOAuthRefreshFailure,
  isStoredOpenAiOAuthTokens,
  normalizeOpenAiOAuthTokenResponse,
  openAiOAuthClientId,
  openAiOAuthLoopbackRedirectUri,
  openAiOAuthRevokeEndpoint,
  openAiOAuthTokenEndpoint,
  parseOpenAiOAuthCallbackUrl,
} from "../../shared/openaiOAuth";
import type {
  OpenAiOAuthStatusInfo,
  OpenAiOAuthTokenResponse,
  StoredOpenAiOAuthTokens,
} from "../../shared/openaiOAuth";
import { toErrorMessage } from "../../shared/utils";
import { normalizeJsonValue } from "../../shared/jsonValue";
import { isRecord } from "../utils";

export const openAiOAuthStorageKey = 'mangaTranslate.openaiOAuth';
export const openAiOAuthPendingStorageKey = 'mangaTranslate.openaiOAuthPending';
export const openAiOAuthLastErrorStorageKey = 'mangaTranslate.openaiOAuthLastError';
export const openAiOAuthInstallationIdStorageKey = 'mangaTranslate.openaiOAuthInstallationId';
const openAiOAuthPendingTtlMs = 10 * 60 * 1000;

type OpenAiRefreshState = {
  current: {
    refreshToken: string;
    promise: Promise<StoredOpenAiOAuthTokens>;
  } | null;
};

class OpenAiOAuthRefreshError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
  }
}

class OpenAiOAuthRefreshSupersededError extends Error {
  constructor() {
    super('OpenAI 登录状态已变化，请重试');
  }
}

type PendingOpenAiOAuthLogin = {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  tabId?: number;
  createdAt: number;
};

export type OpenAiOAuthDependencies = {
  storage: ExtensionStorage;
  authenticationTabs: AuthenticationTabLifecycle;
  authentication: Pick<AuthenticationAccess, 'request' | 'require'>;
};

export type OpenAiOAuthService = {
  status(): Promise<OpenAiOAuthStatusInfo | AuthenticationPermissionRequired>;
  login(): Promise<OpenAiOAuthStatusInfo | AuthenticationPermissionRequired>;
  logout(): Promise<OpenAiOAuthStatusInfo>;
  handleCallbackUrl(
    tabId: number,
    rawUrl: string,
  ): Promise<void | AuthenticationPermissionRequired>;
  handleTabRemoved(tabId: number): Promise<void>;
  getInstallationId(): Promise<string>;
  getValidTokens(): Promise<
    StoredOpenAiOAuthTokens | AuthenticationPermissionRequired
  >;
  refreshTokens(tokens: StoredOpenAiOAuthTokens): Promise<StoredOpenAiOAuthTokens>;
};


function isPendingOpenAiOAuthLogin(value: unknown): value is PendingOpenAiOAuthLogin {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.state === 'string' &&
    typeof value.codeVerifier === 'string' &&
    typeof value.redirectUri === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    (value.tabId === undefined || typeof value.tabId === 'number')
  );
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text } };
  }
}

export function extractResponseError(data: unknown): string | null {
  if (!isRecord(data)) {
    return null;
  }
  const error = data.error;
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  if (typeof data.message === 'string') {
    return data.message;
  }
  if (typeof data.detail === 'string') {
    return data.detail;
  }
  if (typeof data.error_description === 'string') {
    return data.error_description;
  }
  if (typeof data.error === 'string') {
    return data.error;
  }
  return null;
}

function toOpenAiOAuthStatus(tokens: StoredOpenAiOAuthTokens): OpenAiOAuthStatusInfo {
  return {
    authenticated: true,
    email: tokens.email ?? undefined,
    accountId: tokens.accountId ?? undefined,
    planType: tokens.planType ?? undefined,
    expiresAt: tokens.expiresAt,
  };
}

async function getStoredOpenAiOAuthTokens(
  dependencies: OpenAiOAuthDependencies,
): Promise<StoredOpenAiOAuthTokens | null> {
  const values = await dependencies.storage.read([openAiOAuthStorageKey]);
  const saved = values[openAiOAuthStorageKey];
  return isStoredOpenAiOAuthTokens(saved) ? saved : null;
}

async function saveOpenAiOAuthTokens(
  dependencies: OpenAiOAuthDependencies,
  tokens: StoredOpenAiOAuthTokens,
): Promise<StoredOpenAiOAuthTokens> {
  await dependencies.storage.write({
    [openAiOAuthStorageKey]: normalizeJsonValue(tokens),
  });
  return tokens;
}

async function getStoredOpenAiOAuthLastError(
  dependencies: OpenAiOAuthDependencies,
): Promise<string | undefined> {
  const values = await dependencies.storage.read([
    openAiOAuthLastErrorStorageKey,
  ]);
  const saved = values[openAiOAuthLastErrorStorageKey];
  return typeof saved === 'string' && saved.length > 0 ? saved : undefined;
}

async function clearOpenAiOAuthLastError(
  dependencies: OpenAiOAuthDependencies,
): Promise<void> {
  await dependencies.storage.remove([openAiOAuthLastErrorStorageKey]);
}

async function getPendingOpenAiOAuthLogin(
  dependencies: OpenAiOAuthDependencies,
  now = Date.now(),
): Promise<PendingOpenAiOAuthLogin | null> {
  const values = await dependencies.storage.read([openAiOAuthPendingStorageKey]);
  const saved = values[openAiOAuthPendingStorageKey];
  if (!isPendingOpenAiOAuthLogin(saved)) {
    return null;
  }
  if (now - saved.createdAt > openAiOAuthPendingTtlMs) {
    await dependencies.storage.remove([openAiOAuthPendingStorageKey]);
    await dependencies.storage.write({
      [openAiOAuthLastErrorStorageKey]: 'OpenAI 登录已超时，请重新登录',
    });
    return null;
  }
  return saved;
}

async function savePendingOpenAiOAuthLogin(
  dependencies: OpenAiOAuthDependencies,
  pending: PendingOpenAiOAuthLogin,
): Promise<void> {
  await dependencies.storage.write({
    [openAiOAuthPendingStorageKey]: normalizeJsonValue(pending),
  });
}

async function clearPendingOpenAiOAuthLogin(
  dependencies: OpenAiOAuthDependencies,
): Promise<void> {
  await dependencies.storage.remove([openAiOAuthPendingStorageKey]);
}

async function openOpenAiAuthTab(
  dependencies: OpenAiOAuthDependencies,
  url: string,
): Promise<number | undefined> {
  const result = await dependencies.authenticationTabs.open(url);
  if (result.status === 'unavailable') {
    throw new Error(
      '当前浏览器不支持打开 OpenAI 登录页，请确认扩展已授予 tabs 权限',
    );
  }
  return result.tabId;
}

async function closeOpenAiAuthTab(
  dependencies: OpenAiOAuthDependencies,
  tabId?: number,
): Promise<void> {
  if (typeof tabId !== 'number') return;
  await dependencies.authenticationTabs.close(tabId);
}

async function exchangeOpenAiAuthorizationCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<StoredOpenAiOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: openAiOAuthClientId,
    code_verifier: codeVerifier,
  });
  const response = await fetch(openAiOAuthTokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`OpenAI 登录失败: ${extractResponseError(data) ?? `HTTP ${response.status}`}`);
  }
  return normalizeOpenAiOAuthTokenResponse(data as OpenAiOAuthTokenResponse);
}

async function refreshOpenAiOAuthTokens(
  dependencies: OpenAiOAuthDependencies,
  tokens: StoredOpenAiOAuthTokens,
  refreshState: OpenAiRefreshState,
): Promise<StoredOpenAiOAuthTokens> {
  if (refreshState.current?.refreshToken === tokens.refreshToken) {
    return refreshState.current.promise;
  }

  const promise = (async () => {
    const response = await fetch(openAiOAuthTokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: openAiOAuthClientId,
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      }),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      throw new OpenAiOAuthRefreshError(
        `OpenAI 登录已过期: ${extractResponseError(data) ?? `HTTP ${response.status}`}`,
        isPermanentOpenAiOAuthRefreshFailure(data),
      );
    }
    const current = await getStoredOpenAiOAuthTokens(dependencies);
    if (isOpenAiOAuthRefreshSuperseded(current, tokens)) {
      throw new OpenAiOAuthRefreshSupersededError();
    }
    return saveOpenAiOAuthTokens(
      dependencies,
      normalizeOpenAiOAuthTokenResponse(
        data as OpenAiOAuthTokenResponse,
        tokens.refreshToken,
      ),
    );
  })();
  refreshState.current = {
    refreshToken: tokens.refreshToken,
    promise,
  };

  try {
    return await promise;
  } finally {
    if (refreshState.current?.promise === promise) {
      refreshState.current = null;
    }
  }
}

async function getOpenAiOAuthStatus(
  dependencies: OpenAiOAuthDependencies,
  refreshState: OpenAiRefreshState,
): Promise<OpenAiOAuthStatusInfo | AuthenticationPermissionRequired> {
  const permission = await dependencies.authentication.require({
    kind: 'openai-oauth',
  });
  if (isAuthenticationPermissionRequired(permission)) {
    return permission;
  }
  const tokens = await getStoredOpenAiOAuthTokens(dependencies);
  if (!tokens) {
    const pending = await getPendingOpenAiOAuthLogin(dependencies);
    const error = await getStoredOpenAiOAuthLastError(dependencies);
    return {
      authenticated: false,
      pending: Boolean(pending),
      error,
    };
  }
  if (!isOpenAiOAuthExpired(tokens)) {
    return toOpenAiOAuthStatus(tokens);
  }

  try {
    const refreshed = await refreshOpenAiOAuthTokens(
      dependencies,
      tokens,
      refreshState,
    );
    return toOpenAiOAuthStatus(refreshed);
  } catch (error) {
    if (error instanceof OpenAiOAuthRefreshSupersededError) {
      return getOpenAiOAuthStatus(dependencies, refreshState);
    }
    if (error instanceof OpenAiOAuthRefreshError && error.permanent) {
      await dependencies.storage.remove([openAiOAuthStorageKey]);
      await dependencies.storage.write({
        [openAiOAuthLastErrorStorageKey]: toErrorMessage(error),
      });
      return {
        authenticated: false,
        error: toErrorMessage(error),
      };
    }
    await dependencies.storage.write({
      [openAiOAuthLastErrorStorageKey]: toErrorMessage(error),
    });
    return {
      ...toOpenAiOAuthStatus(tokens),
      error: toErrorMessage(error),
    };
  }
}

async function loginOpenAiOAuth(
  dependencies: OpenAiOAuthDependencies,
): Promise<OpenAiOAuthStatusInfo | AuthenticationPermissionRequired> {
  const permission = await dependencies.authentication.request({
    kind: 'openai-oauth',
  });
  if (permission.status === 'denied') {
    return {
      status: 'permission-required',
      missing: permission.missing,
    };
  }
  const redirectUri = openAiOAuthLoopbackRedirectUri;
  const state = createOpenAiOAuthRandomString(32);
  const codeVerifier = createOpenAiOAuthRandomString(64);
  const codeChallenge = await createOpenAiOAuthCodeChallenge(codeVerifier);
  const previousPending = await getPendingOpenAiOAuthLogin(dependencies);
  await clearOpenAiOAuthLastError(dependencies);
  await closeOpenAiAuthTab(dependencies, previousPending?.tabId);
  const pending: PendingOpenAiOAuthLogin = {
    state,
    codeVerifier,
    redirectUri,
    createdAt: Date.now(),
  };
  await savePendingOpenAiOAuthLogin(dependencies, pending);
  const authorizeUrl = buildOpenAiAuthorizeUrl({
    redirectUri,
    codeChallenge,
    state,
  });
  try {
    const tabId = await openOpenAiAuthTab(dependencies, authorizeUrl);
    if (typeof tabId === 'number') {
      await savePendingOpenAiOAuthLogin(dependencies, { ...pending, tabId });
    }
    return { authenticated: false, pending: true };
  } catch (error) {
    await clearPendingOpenAiOAuthLogin(dependencies);
    throw error;
  }
}

async function handleOpenAiOAuthCallbackUrl(
  dependencies: OpenAiOAuthDependencies,
  tabId: number,
  rawUrl: string,
): Promise<void | AuthenticationPermissionRequired> {
  const callback = parseOpenAiOAuthCallbackUrl(rawUrl);
  if (!callback) {
    return;
  }

  const pending = await getPendingOpenAiOAuthLogin(dependencies);
  if (!pending) {
    return;
  }

  const permission = await dependencies.authentication.require({
    kind: 'openai-oauth',
  });
  if (isAuthenticationPermissionRequired(permission)) {
    await clearPendingOpenAiOAuthLogin(dependencies);
    await dependencies.storage.write({
      [openAiOAuthLastErrorStorageKey]:
        'Credential authorization is required',
    });
    await closeOpenAiAuthTab(dependencies, tabId);
    return permission;
  }

  try {
    if ('error' in callback) {
      throw new Error(`OpenAI 登录被拒绝: ${callback.errorDescription ?? callback.error}`);
    }
    if (callback.state !== pending.state) {
      throw new Error('OpenAI 登录状态校验失败，请重试');
    }
    const tokens = await exchangeOpenAiAuthorizationCode(callback.code, pending.redirectUri, pending.codeVerifier);
    await saveOpenAiOAuthTokens(dependencies, tokens);
    await clearPendingOpenAiOAuthLogin(dependencies);
    await clearOpenAiOAuthLastError(dependencies);
    await closeOpenAiAuthTab(dependencies, tabId);
  } catch (error) {
    await clearPendingOpenAiOAuthLogin(dependencies);
    await dependencies.storage.write({
      [openAiOAuthLastErrorStorageKey]: toErrorMessage(error),
    });
    await closeOpenAiAuthTab(dependencies, tabId);
  }
}

async function handleOpenAiOAuthTabRemoved(
  dependencies: OpenAiOAuthDependencies,
  tabId: number,
): Promise<void> {
  const pending = await getPendingOpenAiOAuthLogin(dependencies);
  if (pending?.tabId !== tabId) {
    return;
  }
  await clearPendingOpenAiOAuthLogin(dependencies);
  await dependencies.storage.write({
    [openAiOAuthLastErrorStorageKey]: 'OpenAI 登录窗口已关闭，请重新登录',
  });
}

async function revokeOpenAiOAuthRefreshToken(refreshToken: string): Promise<void> {
  const response = await fetch(openAiOAuthRevokeEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: openAiOAuthClientId,
      token: refreshToken,
      token_type_hint: 'refresh_token',
    }),
  });
  if (!response.ok) {
    const data = await readJsonResponse(response);
    throw new Error(extractResponseError(data) ?? `HTTP ${response.status}`);
  }
}

async function logoutOpenAiOAuth(
  dependencies: OpenAiOAuthDependencies,
): Promise<OpenAiOAuthStatusInfo> {
  const pending = await getPendingOpenAiOAuthLogin(dependencies);
  const tokens = await getStoredOpenAiOAuthTokens(dependencies);
  if (tokens) {
    try {
      await revokeOpenAiOAuthRefreshToken(tokens.refreshToken);
    } catch {
      // Best-effort revoke. Local removal still signs the extension out.
    }
  }
  await closeOpenAiAuthTab(dependencies, pending?.tabId);
  await clearPendingOpenAiOAuthLogin(dependencies);
  await clearOpenAiOAuthLastError(dependencies);
  await dependencies.storage.remove([openAiOAuthStorageKey]);
  return { authenticated: false };
}

export function createOpenAiRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? createOpenAiOAuthRandomString(24);
}

async function getOpenAiOAuthInstallationId(
  dependencies: OpenAiOAuthDependencies,
): Promise<string> {
  const values = await dependencies.storage.read([
    openAiOAuthInstallationIdStorageKey,
  ]);
  const saved = values[openAiOAuthInstallationIdStorageKey];
  if (typeof saved === 'string' && saved.length > 0) {
    return saved;
  }

  const installationId = createOpenAiRequestId();
  await dependencies.storage.write({
    [openAiOAuthInstallationIdStorageKey]: installationId,
  });
  return installationId;
}

async function getValidOpenAiOAuthTokens(
  dependencies: OpenAiOAuthDependencies,
  refreshState: OpenAiRefreshState,
): Promise<StoredOpenAiOAuthTokens | AuthenticationPermissionRequired> {
  const permission = await dependencies.authentication.require({
    kind: 'openai-oauth',
  });
  if (isAuthenticationPermissionRequired(permission)) {
    return permission;
  }
  const tokens = await getStoredOpenAiOAuthTokens(dependencies);
  if (!tokens) {
    throw new Error('请先在扩展弹窗中登录 OpenAI');
  }
  if (!isOpenAiOAuthExpired(tokens)) {
    return tokens;
  }
  return refreshOpenAiOAuthTokens(dependencies, tokens, refreshState);
}

export function createOpenAiOAuthService(
  dependencies: OpenAiOAuthDependencies,
): OpenAiOAuthService {
  const refreshState: OpenAiRefreshState = { current: null };
  return {
    status: () => getOpenAiOAuthStatus(dependencies, refreshState),
    login: () => loginOpenAiOAuth(dependencies),
    logout: () => logoutOpenAiOAuth(dependencies),
    handleCallbackUrl: (tabId, rawUrl) => handleOpenAiOAuthCallbackUrl(
      dependencies,
      tabId,
      rawUrl,
    ),
    handleTabRemoved: (tabId) => handleOpenAiOAuthTabRemoved(
      dependencies,
      tabId,
    ),
    getInstallationId: () => getOpenAiOAuthInstallationId(dependencies),
    getValidTokens: () => getValidOpenAiOAuthTokens(
      dependencies,
      refreshState,
    ),
    refreshTokens: (tokens) => refreshOpenAiOAuthTokens(
      dependencies,
      tokens,
      refreshState,
    ),
  };
}
