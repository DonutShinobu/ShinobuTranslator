import { getChromeApi } from "../../shared/chrome";
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
import {
  storageGet,
  storageRemove,
  storageSet,
} from "../storage/chromeStorage";
import { isRecord } from "../utils";

export const openAiOAuthStorageKey = 'mangaTranslate.openaiOAuth';
export const openAiOAuthPendingStorageKey = 'mangaTranslate.openaiOAuthPending';
export const openAiOAuthLastErrorStorageKey = 'mangaTranslate.openaiOAuthLastError';
export const openAiOAuthInstallationIdStorageKey = 'mangaTranslate.openaiOAuthInstallationId';
const openAiOAuthPendingTtlMs = 10 * 60 * 1000;

let openAiRefreshPromise: {
  refreshToken: string;
  promise: Promise<StoredOpenAiOAuthTokens>;
} | null = null;

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

async function getStoredOpenAiOAuthTokens(): Promise<StoredOpenAiOAuthTokens | null> {
  const saved = await storageGet(openAiOAuthStorageKey);
  return isStoredOpenAiOAuthTokens(saved) ? saved : null;
}

async function saveOpenAiOAuthTokens(tokens: StoredOpenAiOAuthTokens): Promise<StoredOpenAiOAuthTokens> {
  await storageSet(openAiOAuthStorageKey, tokens);
  return tokens;
}

async function getStoredOpenAiOAuthLastError(): Promise<string | undefined> {
  const saved = await storageGet(openAiOAuthLastErrorStorageKey);
  return typeof saved === 'string' && saved.length > 0 ? saved : undefined;
}

async function clearOpenAiOAuthLastError(): Promise<void> {
  await storageRemove(openAiOAuthLastErrorStorageKey);
}

async function getPendingOpenAiOAuthLogin(now = Date.now()): Promise<PendingOpenAiOAuthLogin | null> {
  const saved = await storageGet(openAiOAuthPendingStorageKey);
  if (!isPendingOpenAiOAuthLogin(saved)) {
    return null;
  }
  if (now - saved.createdAt > openAiOAuthPendingTtlMs) {
    await storageRemove(openAiOAuthPendingStorageKey);
    await storageSet(openAiOAuthLastErrorStorageKey, 'OpenAI 登录已超时，请重新登录');
    return null;
  }
  return saved;
}

async function savePendingOpenAiOAuthLogin(pending: PendingOpenAiOAuthLogin): Promise<void> {
  await storageSet(openAiOAuthPendingStorageKey, pending);
}

async function clearPendingOpenAiOAuthLogin(): Promise<void> {
  await storageRemove(openAiOAuthPendingStorageKey);
}

function openOpenAiAuthTab(url: string): Promise<number | undefined> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.tabs?.create) {
    return Promise.reject(new Error('当前浏览器不支持打开 OpenAI 登录页，请确认扩展已授予 tabs 权限'));
  }

  return new Promise((resolve, reject) => {
    chromeApi.tabs?.create?.({ url, active: true }, (tab = {}) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(typeof tab.id === 'number' ? tab.id : undefined);
    });
  });
}

function closeOpenAiAuthTab(tabId?: number): Promise<void> {
  const chromeApi = getChromeApi();
  if (typeof tabId !== 'number' || !chromeApi?.tabs?.remove) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    chromeApi.tabs?.remove?.(tabId, () => {
      resolve();
    });
  });
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

export async function refreshOpenAiOAuthTokens(tokens: StoredOpenAiOAuthTokens): Promise<StoredOpenAiOAuthTokens> {
  if (openAiRefreshPromise?.refreshToken === tokens.refreshToken) {
    return openAiRefreshPromise.promise;
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
    const current = await getStoredOpenAiOAuthTokens();
    if (isOpenAiOAuthRefreshSuperseded(current, tokens)) {
      throw new OpenAiOAuthRefreshSupersededError();
    }
    return saveOpenAiOAuthTokens(normalizeOpenAiOAuthTokenResponse(data as OpenAiOAuthTokenResponse, tokens.refreshToken));
  })();
  openAiRefreshPromise = {
    refreshToken: tokens.refreshToken,
    promise,
  };

  try {
    return await promise;
  } finally {
    if (openAiRefreshPromise?.promise === promise) {
      openAiRefreshPromise = null;
    }
  }
}

export async function getOpenAiOAuthStatus(): Promise<OpenAiOAuthStatusInfo> {
  const tokens = await getStoredOpenAiOAuthTokens();
  if (!tokens) {
    const pending = await getPendingOpenAiOAuthLogin();
    const error = await getStoredOpenAiOAuthLastError();
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
    const refreshed = await refreshOpenAiOAuthTokens(tokens);
    return toOpenAiOAuthStatus(refreshed);
  } catch (error) {
    if (error instanceof OpenAiOAuthRefreshSupersededError) {
      return getOpenAiOAuthStatus();
    }
    if (error instanceof OpenAiOAuthRefreshError && error.permanent) {
      await storageRemove(openAiOAuthStorageKey);
      await storageSet(openAiOAuthLastErrorStorageKey, toErrorMessage(error));
      return {
        authenticated: false,
        error: toErrorMessage(error),
      };
    }
    await storageSet(openAiOAuthLastErrorStorageKey, toErrorMessage(error));
    return {
      ...toOpenAiOAuthStatus(tokens),
      error: toErrorMessage(error),
    };
  }
}

export async function loginOpenAiOAuth(): Promise<OpenAiOAuthStatusInfo> {
  const redirectUri = openAiOAuthLoopbackRedirectUri;
  const state = createOpenAiOAuthRandomString(32);
  const codeVerifier = createOpenAiOAuthRandomString(64);
  const codeChallenge = await createOpenAiOAuthCodeChallenge(codeVerifier);
  const previousPending = await getPendingOpenAiOAuthLogin();
  await clearOpenAiOAuthLastError();
  await closeOpenAiAuthTab(previousPending?.tabId);
  const pending: PendingOpenAiOAuthLogin = {
    state,
    codeVerifier,
    redirectUri,
    createdAt: Date.now(),
  };
  await savePendingOpenAiOAuthLogin(pending);
  const authorizeUrl = buildOpenAiAuthorizeUrl({
    redirectUri,
    codeChallenge,
    state,
  });
  try {
    const tabId = await openOpenAiAuthTab(authorizeUrl);
    if (typeof tabId === 'number') {
      await savePendingOpenAiOAuthLogin({ ...pending, tabId });
    }
    return { authenticated: false, pending: true };
  } catch (error) {
    await clearPendingOpenAiOAuthLogin();
    throw error;
  }
}

export async function handleOpenAiOAuthCallbackUrl(tabId: number, rawUrl: string): Promise<void> {
  const callback = parseOpenAiOAuthCallbackUrl(rawUrl);
  if (!callback) {
    return;
  }

  const pending = await getPendingOpenAiOAuthLogin();
  if (!pending) {
    return;
  }

  try {
    if ('error' in callback) {
      throw new Error(`OpenAI 登录被拒绝: ${callback.errorDescription ?? callback.error}`);
    }
    if (callback.state !== pending.state) {
      throw new Error('OpenAI 登录状态校验失败，请重试');
    }
    const tokens = await exchangeOpenAiAuthorizationCode(callback.code, pending.redirectUri, pending.codeVerifier);
    await saveOpenAiOAuthTokens(tokens);
    await clearPendingOpenAiOAuthLogin();
    await clearOpenAiOAuthLastError();
    await closeOpenAiAuthTab(tabId);
  } catch (error) {
    await clearPendingOpenAiOAuthLogin();
    await storageSet(openAiOAuthLastErrorStorageKey, toErrorMessage(error));
    await closeOpenAiAuthTab(tabId);
  }
}

export async function handleOpenAiOAuthTabRemoved(tabId: number): Promise<void> {
  const pending = await getPendingOpenAiOAuthLogin();
  if (pending?.tabId !== tabId) {
    return;
  }
  await clearPendingOpenAiOAuthLogin();
  await storageSet(openAiOAuthLastErrorStorageKey, 'OpenAI 登录窗口已关闭，请重新登录');
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

export async function logoutOpenAiOAuth(): Promise<OpenAiOAuthStatusInfo> {
  const pending = await getPendingOpenAiOAuthLogin();
  const tokens = await getStoredOpenAiOAuthTokens();
  if (tokens) {
    try {
      await revokeOpenAiOAuthRefreshToken(tokens.refreshToken);
    } catch {
      // Best-effort revoke. Local removal still signs the extension out.
    }
  }
  await closeOpenAiAuthTab(pending?.tabId);
  await clearPendingOpenAiOAuthLogin();
  await clearOpenAiOAuthLastError();
  await storageRemove(openAiOAuthStorageKey);
  return { authenticated: false };
}

export function createOpenAiRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? createOpenAiOAuthRandomString(24);
}

export async function getOpenAiOAuthInstallationId(): Promise<string> {
  const saved = await storageGet(openAiOAuthInstallationIdStorageKey);
  if (typeof saved === 'string' && saved.length > 0) {
    return saved;
  }

  const installationId = createOpenAiRequestId();
  await storageSet(openAiOAuthInstallationIdStorageKey, installationId);
  return installationId;
}

export async function getValidOpenAiOAuthTokens(): Promise<StoredOpenAiOAuthTokens> {
  const tokens = await getStoredOpenAiOAuthTokens();
  if (!tokens) {
    throw new Error('请先在扩展弹窗中登录 OpenAI');
  }
  if (!isOpenAiOAuthExpired(tokens)) {
    return tokens;
  }
  return refreshOpenAiOAuthTokens(tokens);
}
