import {
  defaultExtensionSettings,
  extensionSettingsStorageKey,
  normalizeSettings,
  type ExtensionSettings,
} from '../shared/config';
import { getChromeApi } from '../shared/chrome';
import {
  isRuntimeMessage,
  type LlmChatCompletionRequestBody,
  type RuntimeMessage,
  type RuntimeResponse,
} from '../shared/messages';
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
  openAiOAuthOriginator,
  openAiOAuthRevokeEndpoint,
  openAiOAuthTokenEndpoint,
  parseOpenAiOAuthCallbackUrl,
  type OpenAiOAuthStatusInfo,
  type OpenAiOAuthTokenResponse,
  type StoredOpenAiOAuthTokens,
} from '../shared/openaiOAuth';
import {
  buildOpenAiResponsesRequest,
  extractOpenAiResponsesJsonText,
  extractOpenAiResponsesSseText,
} from '../shared/openaiResponses';
import { toErrorMessage } from '../shared/utils';

const openAiOAuthStorageKey = 'mangaTranslate.openaiOAuth';
const openAiOAuthPendingStorageKey = 'mangaTranslate.openaiOAuthPending';
const openAiOAuthLastErrorStorageKey = 'mangaTranslate.openaiOAuthLastError';
const openAiOAuthInstallationIdStorageKey = 'mangaTranslate.openaiOAuthInstallationId';
const openAiOAuthPendingTtlMs = 10 * 60 * 1000;
const openAiCodexResponsesEndpoint = 'https://chatgpt.com/backend-api/codex/responses';

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

function storageGet(key: string): Promise<unknown> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.storage?.local?.get) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    chromeApi.storage?.local?.get?.([key], (items: Record<string, unknown>) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(items[key]);
    });
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.storage?.local?.set) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    chromeApi.storage?.local?.set?.({ [key]: value }, () => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

function storageRemove(key: string): Promise<void> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.storage?.local?.remove) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    chromeApi.storage?.local?.remove?.([key], () => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function getSettings(): Promise<ExtensionSettings> {
  const saved = await storageGet(extensionSettingsStorageKey);
  return normalizeSettings(saved);
}

async function setSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const normalized = normalizeSettings(settings);
  await storageSet(extensionSettingsStorageKey, normalized);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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

async function readJsonResponse(response: Response): Promise<unknown> {
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

function extractResponseError(data: unknown): string | null {
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

async function refreshOpenAiOAuthTokens(tokens: StoredOpenAiOAuthTokens): Promise<StoredOpenAiOAuthTokens> {
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

async function getOpenAiOAuthStatus(): Promise<OpenAiOAuthStatusInfo> {
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

async function loginOpenAiOAuth(): Promise<OpenAiOAuthStatusInfo> {
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

async function handleOpenAiOAuthCallbackUrl(tabId: number, rawUrl: string): Promise<void> {
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

async function handleOpenAiOAuthTabRemoved(tabId: number): Promise<void> {
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

async function logoutOpenAiOAuth(): Promise<OpenAiOAuthStatusInfo> {
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

function createOpenAiRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? createOpenAiOAuthRandomString(24);
}

async function getOpenAiOAuthInstallationId(): Promise<string> {
  const saved = await storageGet(openAiOAuthInstallationIdStorageKey);
  if (typeof saved === 'string' && saved.length > 0) {
    return saved;
  }

  const installationId = createOpenAiRequestId();
  await storageSet(openAiOAuthInstallationIdStorageKey, installationId);
  return installationId;
}

async function getValidOpenAiOAuthTokens(): Promise<StoredOpenAiOAuthTokens> {
  const tokens = await getStoredOpenAiOAuthTokens();
  if (!tokens) {
    throw new Error('请先在扩展弹窗中登录 OpenAI');
  }
  if (!isOpenAiOAuthExpired(tokens)) {
    return tokens;
  }
  return refreshOpenAiOAuthTokens(tokens);
}

async function fetchOpenAiCodexResponses(
  body: LlmChatCompletionRequestBody,
  tokens: StoredOpenAiOAuthTokens,
): Promise<Response> {
  if (!tokens.accountId) {
    throw new Error('OpenAI 登录缺少账号 ID，请退出后重新登录');
  }

  const installationId = await getOpenAiOAuthInstallationId();
  const sessionId = createOpenAiRequestId();
  const threadId = createOpenAiRequestId();
  const request = buildOpenAiResponsesRequest(body, {
    'x-codex-installation-id': installationId,
  });

  return fetch(openAiCodexResponsesEndpoint, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.accessToken}`,
      originator: openAiOAuthOriginator,
      'chatgpt-account-id': tokens.accountId,
      'session-id': sessionId,
      'thread-id': threadId,
    },
    body: JSON.stringify(request),
  });
}

async function readOpenAiCodexResponsesText(response: Response): Promise<string | null> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/event-stream')) {
    return extractOpenAiResponsesSseText(text);
  }

  try {
    return extractOpenAiResponsesJsonText(JSON.parse(text) as unknown);
  } catch {
    return extractOpenAiResponsesSseText(text);
  }
}

function toChatCompletionsResponse(content: string, model: string): unknown {
  return {
    id: `shinobu-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
  };
}

async function proxyOpenAiChatCompletions(body: LlmChatCompletionRequestBody): Promise<unknown> {
  let tokens = await getValidOpenAiOAuthTokens();
  let response = await fetchOpenAiCodexResponses(body, tokens);
  if (response.status === 401) {
    tokens = await refreshOpenAiOAuthTokens(tokens);
    response = await fetchOpenAiCodexResponses(body, tokens);
  }

  if (!response.ok) {
    const data = await readJsonResponse(response);
    throw new Error(`OpenAI ChatGPT 请求失败: ${extractResponseError(data) ?? `HTTP ${response.status}`}`);
  }

  const content = await readOpenAiCodexResponsesText(response);
  if (!content) {
    throw new Error('OpenAI ChatGPT 响应为空');
  }
  return toChatCompletionsResponse(content, body.model);
}

function buildOriginalCandidates(imageUrl: string): string[] {
  const urls: string[] = [];
  try {
    const parsed = new URL(imageUrl);
    if (parsed.hostname === 'pbs.twimg.com' && (parsed.searchParams.has('name') || parsed.searchParams.has('format'))) {
      const withOrig = new URL(parsed.toString());
      withOrig.searchParams.set('name', 'orig');
      urls.push(withOrig.toString());
    }
  } catch {
    // ignore parse error and fallback to original URL
  }
  urls.push(imageUrl);
  return Array.from(new Set(urls));
}

function getRefererForUrl(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === 'i.pximg.net' || hostname.endsWith('.pximg.net')) {
      return 'https://www.pixiv.net/';
    }
  } catch {
    // ignore
  }
  return undefined;
}

// Use declarativeNetRequest to set Referer for pximg.net requests,
// since service worker fetch() cannot override Referer reliably.
async function ensurePximgRefererRule(): Promise<void> {
  const api = (globalThis as any).chrome?.declarativeNetRequest;
  if (!api) return;
  const RULE_ID = 1;
  try {
    await api.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: [{
        id: RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{
            header: 'Referer',
            operation: 'set',
            value: 'https://www.pixiv.net/',
          }],
        },
        condition: {
          urlFilter: '||i.pximg.net/',
          resourceTypes: ['xmlhttprequest'],
        },
      }],
    });
  } catch {
    // ignore
  }
}

ensurePximgRefererRule();

async function downloadImage(imageUrl: string): Promise<{
  base64: string;
  contentType: string;
  sourceUrl: string;
}> {
  const candidates = buildOriginalCandidates(imageUrl);
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const headers: Record<string, string> = {};
      const referer = getRefererForUrl(url);
      if (referer) headers['Referer'] = referer;
      const response = await fetch(url, { method: 'GET', cache: 'no-store', headers });
      if (!response.ok) {
        errors.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) {
        errors.push(`${url}: 返回空文件`);
        continue;
      }
      return {
        base64: arrayBufferToBase64(buffer),
        contentType: response.headers.get('content-type') ?? 'image/jpeg',
        sourceUrl: url,
      };
    } catch (error) {
      errors.push(`${url}: ${toErrorMessage(error)}`);
    }
  }
  throw new Error(`下载图片失败: ${errors.join(' | ') || '未知错误'}`);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function handleMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  if (message.type === 'mt:get-settings') {
    const settings = await getSettings();
    return {
      ok: true,
      type: 'mt:get-settings',
      settings,
    };
  }

  if (message.type === 'mt:set-settings') {
    const settings = await setSettings(message.settings);
    return {
      ok: true,
      type: 'mt:set-settings',
      settings,
    };
  }

  if (message.type === 'mt:download-image') {
    const downloaded = await downloadImage(message.imageUrl);
    return {
      ok: true,
      type: 'mt:download-image',
      ...downloaded,
    };
  }

  if (message.type === 'mt:openai-oauth-status') {
    return {
      ok: true,
      type: 'mt:openai-oauth-status',
      status: await getOpenAiOAuthStatus(),
    };
  }

  if (message.type === 'mt:openai-oauth-login') {
    return {
      ok: true,
      type: 'mt:openai-oauth-login',
      status: await loginOpenAiOAuth(),
    };
  }

  if (message.type === 'mt:openai-oauth-logout') {
    return {
      ok: true,
      type: 'mt:openai-oauth-logout',
      status: await logoutOpenAiOAuth(),
    };
  }

  if (message.type === 'mt:llm-chat-completions') {
    return {
      ok: true,
      type: 'mt:llm-chat-completions',
      data: await proxyOpenAiChatCompletions(message.body),
    };
  }

  return {
    ok: false,
    type: 'mt:get-settings',
    error: '不支持的消息类型',
  };
}

function initializeBackground(): void {
  const chromeApi = getChromeApi();
  if (!chromeApi?.runtime?.onMessage?.addListener) {
    return;
  }

  chromeApi.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
    if (!isRuntimeMessage(message)) {
      return false;
    }

    void handleMessage(message)
      .then((response) => {
        sendResponse(response);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          type: message.type,
          error: toErrorMessage(error),
        } satisfies RuntimeResponse);
      });
    return true;
  });

  chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    if (typeof changeInfo.url === 'string') {
      void handleOpenAiOAuthCallbackUrl(tabId, changeInfo.url);
    }
  });

  chromeApi.tabs?.onRemoved?.addListener((tabId) => {
    void handleOpenAiOAuthTabRemoved(tabId);
  });

  void getSettings()
    .catch(() => defaultExtensionSettings)
    .then((settings) => storageSet(extensionSettingsStorageKey, settings))
    .catch(() => undefined);

  // Register context menu for image translation
  const fullChrome = (globalThis as any).chrome;
  if (fullChrome?.contextMenus?.create) {
    fullChrome.contextMenus.create({
      id: 'translate-image',
      title: '翻译图片',
      contexts: ['image'],
    });
    fullChrome.contextMenus.onClicked.addListener((info: any, tab: any) => {
      if (info.menuItemId === 'translate-image' && tab?.id != null) {
        fullChrome.tabs.sendMessage(tab.id, { type: 'mt:context-menu-translate' }).catch(() => {
          // content script may not be injected yet — ignore
        });
      }
    });
  }
}

void initializeBackground();
