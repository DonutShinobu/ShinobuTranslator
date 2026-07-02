import {
  defaultExtensionSettings,
  extensionSettingsStorageKey,
  getGeminiAppModelLabel,
  normalizeSettings,
  resolveGeminiApiImageModel,
  resolveLlmBaseUrl,
  usesGeminiApiImagePipeline,
  usesGeminiAppImagePipeline,
  validateSettings,
  type ExtensionSettings,
} from '../shared/config';
import { getChromeApi } from '../shared/chrome';
import type { ChromeMessageSender } from '../shared/chrome';
import {
  classifyLlmFetchError,
  createDiagnosticEvent,
  createDiagnosticId,
  formatDiagnosticTextLog,
  normalizeDiagnosticTimestamp,
  redactDiagnosticValue,
  sanitizeDiagnosticUrl,
  sanitizeExtensionSettings,
  toDiagnosticError,
  type DiagnosticLogEvent,
  type DiagnosticLogEventInput,
  type DiagnosticLogRun,
  type DiagnosticLogTextExport,
} from '../shared/diagnosticLog';
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
import { arrayBufferToBase64, toErrorMessage } from '../shared/utils';
import { runGeminiApiImageTranslate } from './geminiApiImageClient';
import { getGeminiAppAuthStatus, getGeminiAppRawResponse, runGeminiAppImageTranslate } from './geminiAppClient';
import {
  LlmChatCompletionHttpError,
  LlmChatCompletionParseError,
  proxyApiKeyChatCompletions,
  resolveLlmChatCompletionsEndpoint,
} from './llmProxy';

const openAiOAuthStorageKey = 'mangaTranslate.openaiOAuth';
const openAiOAuthPendingStorageKey = 'mangaTranslate.openaiOAuthPending';
const openAiOAuthLastErrorStorageKey = 'mangaTranslate.openaiOAuthLastError';
const openAiOAuthInstallationIdStorageKey = 'mangaTranslate.openaiOAuthInstallationId';
const diagnosticLogStorageKey = 'mangaTranslate.diagnosticLog';
const backgroundDiagnosticSessionId = createDiagnosticId('background-session');
const openAiOAuthPendingTtlMs = 10 * 60 * 1000;
const openAiCodexResponsesEndpoint = 'https://chatgpt.com/backend-api/codex/responses';
const geminiAppUrl = 'https://gemini.google.com/app';
const startScreenshotTranslateCommand = 'start-screenshot-translate';
const translateHoverTargetCommand = 'translate-hover-target';

let openAiRefreshPromise: {
  refreshToken: string;
  promise: Promise<StoredOpenAiOAuthTokens>;
} | null = null;
let diagnosticLogWriteQueue: Promise<void> = Promise.resolve();

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

type DiagnosticLogStore = {
  events: DiagnosticLogEvent[];
  truncated?: boolean;
  truncationReason?: string;
};

const diagnosticLogMaxEvents = 2000;

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

function isDiagnosticLogEvent(value: unknown): value is DiagnosticLogEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.timestamp === 'string' &&
    typeof value.level === 'string' &&
    typeof value.category === 'string' &&
    isRecord(value.source) &&
    typeof value.source.context === 'string' &&
    typeof value.message === 'string'
  );
}

function isDiagnosticLogStore(value: unknown): value is DiagnosticLogStore {
  if (!isRecord(value) || !Array.isArray(value.events)) return false;
  return value.events.every(isDiagnosticLogEvent);
}

async function readDiagnosticLogStore(): Promise<DiagnosticLogStore> {
  const saved = await storageGet(diagnosticLogStorageKey);
  if (isDiagnosticLogStore(saved)) {
    return saved;
  }
  return { events: [] };
}

async function writeDiagnosticLogStore(store: DiagnosticLogStore): Promise<void> {
  await storageSet(diagnosticLogStorageKey, store);
}

async function appendDiagnosticLogEvent(event: DiagnosticLogEvent): Promise<void> {
  const store = await readDiagnosticLogStore();
  const normalized = createDiagnosticEvent(event, event.sessionId);
  const events = [...store.events, normalized];
  const overflow = Math.max(0, events.length - diagnosticLogMaxEvents);
  const nextEvents = overflow > 0 ? events.slice(overflow) : events;
  await writeDiagnosticLogStore({
    events: nextEvents,
    truncated: store.truncated || overflow > 0,
    truncationReason: overflow > 0 ? `事件数量超过 ${diagnosticLogMaxEvents}，已丢弃最早的 ${overflow} 条` : store.truncationReason,
  });
}

function recordDiagnosticLogEvent(event: DiagnosticLogEvent): Promise<void> {
  const write = diagnosticLogWriteQueue.then(
    () => appendDiagnosticLogEvent(event),
    () => appendDiagnosticLogEvent(event),
  );
  diagnosticLogWriteQueue = write.catch(() => undefined);
  return write;
}

function toImageTranslateDiagnosticData(image: { base64: string; contentType: string; filename: string }): Record<string, unknown> {
  return {
    contentType: image.contentType,
    filename: image.filename,
    base64Length: image.base64.length,
  };
}

async function recordBackgroundDiagnosticLog(
  settings: ExtensionSettings,
  event: DiagnosticLogEventInput,
): Promise<void> {
  if (!settings.enableDebugLog || !event.runId) {
    return;
  }
  try {
    await recordDiagnosticLogEvent(createDiagnosticEvent(event, event.sessionId ?? backgroundDiagnosticSessionId));
  } catch {
    // Diagnostic writes are best-effort and must not affect API requests.
  }
}

function deriveDiagnosticRuns(events: DiagnosticLogEvent[]): DiagnosticLogRun[] {
  const runs = new Map<string, DiagnosticLogRun>();
  for (const event of events) {
    if (!event.runId) continue;
    const timestamp = normalizeDiagnosticTimestamp(event.timestamp);
    const existing = runs.get(event.runId);
    if (!existing) {
      runs.set(event.runId, {
        runId: event.runId,
        startedAt: timestamp,
        status: 'running',
        label: typeof event.data?.label === 'string' ? event.data.label : undefined,
      });
      continue;
    }
    if (timestamp < existing.startedAt) {
      existing.startedAt = timestamp;
    }
    const runStatus = event.data?.runStatus;
    if (runStatus === 'success' || runStatus === 'failed') {
      existing.status = runStatus;
      existing.finishedAt = timestamp;
      existing.error = event.error?.message ?? (typeof event.data?.error === 'string' ? event.data.error : existing.error);
    }
  }
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function exportDiagnosticLog(): Promise<DiagnosticLogTextExport> {
  await diagnosticLogWriteQueue.catch(() => undefined);
  const store = await readDiagnosticLogStore();
  const settings = await getSettings();
  const chromeApi = getChromeApi();
  const manifest = chromeApi?.runtime?.getManifest?.();
  const events = redactDiagnosticValue(store.events) as DiagnosticLogEvent[];
  const exportedAt = new Date().toISOString();
  const extension = {
    version: manifest?.version,
    manifestVersion: 3,
  };
  const environment = {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    language: typeof navigator !== 'undefined' ? navigator.language : undefined,
    platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
    crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : undefined,
  };
  const activeSettings = sanitizeExtensionSettings(settings);
  const runs = deriveDiagnosticRuns(events);
  return {
    schemaVersion: 1,
    exportedAt,
    filenamePrefix: 'shinobu-diagnostic-log',
    contentType: 'text/plain;charset=utf-8',
    eventCount: events.length,
    text: formatDiagnosticTextLog(events, {
      exportedAt,
      extension,
      environment,
      activeSettings,
      runs,
      truncated: store.truncated,
      truncationReason: store.truncationReason,
    }),
  };
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

function getLlmProxyEndpoint(settings: ExtensionSettings): string {
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'openai' && profile.authMode === 'openai_oauth') {
    return openAiCodexResponsesEndpoint;
  }
  return resolveLlmChatCompletionsEndpoint(settings);
}

function getLlmProxyErrorData(error: unknown): Record<string, unknown> {
  if (error instanceof LlmChatCompletionHttpError) {
    return {
      status: error.status,
      statusText: error.statusText,
      contentType: error.contentType,
      responseText: error.responseText,
    };
  }
  if (error instanceof LlmChatCompletionParseError) {
    return {
      status: error.status,
      contentType: error.contentType,
      responseText: error.responseText,
    };
  }
  return {};
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
  const api = getChromeApi()?.declarativeNetRequest;
  if (!api?.updateDynamicRules) return;
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

function parseImageDataUrl(dataUrl: string): {
  base64: string;
  contentType: string;
} {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    throw new Error('截图数据格式无效');
  }
  return {
    contentType: match[1] || 'image/png',
    base64: match[2] || '',
  };
}

function captureVisibleTab(sender: ChromeMessageSender): Promise<{
  base64: string;
  contentType: string;
  sourceUrl: string;
}> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.tabs?.captureVisibleTab) {
    return Promise.reject(new Error('当前浏览器不支持标签页截图'));
  }

  const windowId = typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : undefined;
  return new Promise((resolve, reject) => {
    chromeApi.tabs?.captureVisibleTab?.(windowId, { format: 'png' }, (dataUrl?: string) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      if (!dataUrl) {
        reject(new Error('截图返回为空'));
        return;
      }
      const parsed = parseImageDataUrl(dataUrl);
      resolve({
        ...parsed,
        sourceUrl: sender.tab?.url ?? '',
      });
    });
  });
}

function openGeminiAppAuthTab(): Promise<void> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.tabs?.create) {
    return Promise.reject(new Error('当前浏览器不支持打开 Gemini 登录页，请确认扩展已授予 tabs 权限'));
  }

  return new Promise((resolve, reject) => {
    chromeApi.tabs?.create?.({ url: geminiAppUrl, active: true }, () => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function handleMessage(message: RuntimeMessage, sender: ChromeMessageSender): Promise<RuntimeResponse> {
  if (message.type === 'mt:diagnostic-log-event') {
    try {
      const settings = await getSettings();
      if (settings.enableDebugLog) {
        await recordDiagnosticLogEvent(message.event);
      }
    } catch {
      // Diagnostic writes are best-effort and must not affect callers.
    }
    return {
      ok: true,
      type: 'mt:diagnostic-log-event',
    };
  }

  if (message.type === 'mt:diagnostic-log-export') {
    return {
      ok: true,
      type: 'mt:diagnostic-log-export',
      log: await exportDiagnosticLog(),
    };
  }

  if (message.type === 'mt:diagnostic-log-clear') {
    await storageRemove(diagnosticLogStorageKey);
    return {
      ok: true,
      type: 'mt:diagnostic-log-clear',
    };
  }

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

  if (message.type === 'mt:capture-visible-tab') {
    const captured = await captureVisibleTab(sender);
    return {
      ok: true,
      type: 'mt:capture-visible-tab',
      ...captured,
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

  if (message.type === 'mt:gemini-app-auth-status') {
    const settings = await getSettings();
    return {
      ok: true,
      type: 'mt:gemini-app-auth-status',
      status: await getGeminiAppAuthStatus(settings),
    };
  }

  if (message.type === 'mt:gemini-app-auth-login') {
    const settings = await getSettings();
    const status = await getGeminiAppAuthStatus(settings);
    if (status.authenticated) {
      return {
        ok: true,
        type: 'mt:gemini-app-auth-login',
        status,
      };
    }
    await openGeminiAppAuthTab();
    return {
      ok: true,
      type: 'mt:gemini-app-auth-login',
      status: { authenticated: false, pending: true },
    };
  }

  if (message.type === 'mt:llm-chat-completions') {
    const settings = await getSettings();
    const profile = settings.llmProfiles[settings.llmProvider];
    const startedAt = Date.now();
    const baseLogData = {
      provider: settings.llmProvider,
      authMode: profile.authMode,
      endpoint: sanitizeDiagnosticUrl(getLlmProxyEndpoint(settings)),
      model: message.body.model,
      messageCount: message.body.messages.length,
      responseFormat: message.body.response_format?.type ?? 'default',
      requestBody: message.body,
      backgroundDirectFetch: true,
      contentDirectFetch: false,
    };
    await recordBackgroundDiagnosticLog(settings, {
      runId: message.diagnosticRunId,
      level: 'info',
      category: 'llm.api',
      source: { context: 'background', module: 'background/index.ts' },
      message: `${settings.llmProvider} LLM 代理请求开始`,
      data: baseLogData,
    });
    try {
      const data = settings.llmProvider === 'openai' && profile.authMode === 'openai_oauth'
        ? await proxyOpenAiChatCompletions(message.body)
        : await proxyApiKeyChatCompletions(settings, message.body);
      await recordBackgroundDiagnosticLog(settings, {
        runId: message.diagnosticRunId,
        level: 'info',
        category: 'llm.api',
        source: { context: 'background', module: 'background/index.ts' },
        message: `${settings.llmProvider} LLM 代理请求完成`,
        data: {
          ...baseLogData,
          durationMs: Date.now() - startedAt,
          responseData: data,
        },
      });
      return {
        ok: true,
        type: 'mt:llm-chat-completions',
        data,
      };
    } catch (error) {
      const classification = classifyLlmFetchError(
        error,
        error instanceof LlmChatCompletionHttpError ? error.status : undefined,
      );
      await recordBackgroundDiagnosticLog(settings, {
        runId: message.diagnosticRunId,
        level: 'error',
        category: 'llm.api',
        source: { context: 'background', module: 'background/index.ts' },
        message: `${settings.llmProvider} LLM 代理请求失败：${classification.reason}`,
        data: {
          ...baseLogData,
          durationMs: Date.now() - startedAt,
          classification,
          ...getLlmProxyErrorData(error),
        },
        error: toDiagnosticError(error),
      });
      throw error;
    }
  }

  if (message.type === 'mt:gemini-app-image-translate') {
    const settings = await getSettings();
    const validationError = usesGeminiAppImagePipeline(settings)
      ? validateSettings(settings)
      : '请先在扩展弹窗中选择“大模型”，将 LLM 提供商设为 Nano Banana，并选择 Gemini 登录认证';
    if (validationError) {
      throw new Error(validationError);
    }
    const startedAt = Date.now();
    const baseLogData = {
      provider: 'gemini',
      authMode: 'gemini_app',
      endpoint: sanitizeDiagnosticUrl(geminiAppUrl),
      modelLabel: getGeminiAppModelLabel(settings.geminiAppModel),
      image: toImageTranslateDiagnosticData(message.image),
      backgroundDirectFetch: true,
      contentDirectFetch: false,
    };
    await recordBackgroundDiagnosticLog(settings, {
      runId: message.diagnosticRunId,
      level: 'info',
      category: 'llm.api',
      source: { context: 'background', module: 'geminiAppClient.ts' },
      message: 'Gemini App 全图翻译请求开始',
      data: baseLogData,
    });
    try {
      const translated = await runGeminiAppImageTranslate({
        imageBase64: message.image.base64,
        contentType: message.image.contentType,
        filename: message.image.filename,
        settings,
      });
      await recordBackgroundDiagnosticLog(settings, {
        runId: message.diagnosticRunId,
        level: 'info',
        category: 'llm.api',
        source: { context: 'background', module: 'geminiAppClient.ts' },
        message: 'Gemini App 全图翻译请求完成',
        data: {
          ...baseLogData,
          durationMs: Date.now() - startedAt,
          output: {
            contentType: translated.contentType,
            base64Length: translated.base64.length,
          },
          metadata: {
            ...translated.metadata,
            imageUrl: translated.metadata.imageUrl ? sanitizeDiagnosticUrl(translated.metadata.imageUrl) : undefined,
          },
        },
      });
      return {
        ok: true,
        type: 'mt:gemini-app-image-translate',
        ...translated,
      };
    } catch (error) {
      const classification = classifyLlmFetchError(error);
      const rawResponse = getGeminiAppRawResponse(error);
      await recordBackgroundDiagnosticLog(settings, {
        runId: message.diagnosticRunId,
        level: 'error',
        category: 'llm.api',
        source: { context: 'background', module: 'geminiAppClient.ts' },
        message: `Gemini App 全图翻译请求失败：${classification.reason}`,
        data: {
          ...baseLogData,
          durationMs: Date.now() - startedAt,
          classification,
          rawResponse: rawResponse ?? undefined,
        },
        error: toDiagnosticError(error),
      });
      throw error;
    }
  }

  if (message.type === 'mt:gemini-api-image-translate') {
    const settings = await getSettings();
    const validationError = usesGeminiApiImagePipeline(settings)
      ? validateSettings(settings)
      : '请先在扩展弹窗中选择“大模型”，将 LLM 提供商设为 Nano Banana，并选择 API Key 认证';
    if (validationError) {
      throw new Error(validationError);
    }
    const startedAt = Date.now();
    const model = resolveGeminiApiImageModel(settings.geminiAppModel);
    const endpoint = `${resolveLlmBaseUrl(settings).replace(/\/+$/u, '')}/models/${encodeURIComponent(model)}:generateContent`;
    const baseLogData = {
      provider: 'gemini',
      authMode: 'api_key',
      endpoint: sanitizeDiagnosticUrl(endpoint),
      model,
      modelLabel: getGeminiAppModelLabel(settings.geminiAppModel),
      image: toImageTranslateDiagnosticData(message.image),
      backgroundDirectFetch: true,
      contentDirectFetch: false,
    };
    await recordBackgroundDiagnosticLog(settings, {
      runId: message.diagnosticRunId,
      level: 'info',
      category: 'llm.api',
      source: { context: 'background', module: 'geminiApiImageClient.ts' },
      message: 'Gemini API 全图翻译请求开始',
      data: baseLogData,
    });
    try {
      const translated = await runGeminiApiImageTranslate({
        imageBase64: message.image.base64,
        contentType: message.image.contentType,
        filename: message.image.filename,
        settings,
      });
      await recordBackgroundDiagnosticLog(settings, {
        runId: message.diagnosticRunId,
        level: 'info',
        category: 'llm.api',
        source: { context: 'background', module: 'geminiApiImageClient.ts' },
        message: 'Gemini API 全图翻译请求完成',
        data: {
          ...baseLogData,
          durationMs: Date.now() - startedAt,
          output: {
            contentType: translated.contentType,
            base64Length: translated.base64.length,
          },
          metadata: translated.metadata,
        },
      });
      return {
        ok: true,
        type: 'mt:gemini-api-image-translate',
        ...translated,
      };
    } catch (error) {
      const classification = classifyLlmFetchError(error);
      await recordBackgroundDiagnosticLog(settings, {
        runId: message.diagnosticRunId,
        level: 'error',
        category: 'llm.api',
        source: { context: 'background', module: 'geminiApiImageClient.ts' },
        message: `Gemini API 全图翻译请求失败：${classification.reason}`,
        data: {
          ...baseLogData,
          durationMs: Date.now() - startedAt,
          classification,
        },
        error: toDiagnosticError(error),
      });
      throw error;
    }
  }

  return {
    ok: false,
    type: message.type,
    error: '不支持的消息类型',
  };
}

function registerContextMenus(): void {
  const chromeApi = getChromeApi();
  if (!chromeApi?.contextMenus?.create) return;

  chromeApi.contextMenus.create({
    id: 'translate-image',
    title: '翻译图片',
    contexts: ['all'],
  });
  chromeApi.contextMenus.create({
    id: 'translate-screenshot',
    title: '截图翻译',
    contexts: ['all'],
  });
}

function sendTabMessage(tabId: number, message: RuntimeMessage): void {
  const chromeApi = getChromeApi();
  if (!chromeApi?.tabs?.sendMessage) return;
  chromeApi.tabs.sendMessage(tabId, message).catch(() => {
    // content script may not be injected yet — ignore
  });
}

function initializeBackground(): void {
  const chromeApi = getChromeApi();
  if (!chromeApi?.runtime?.onMessage?.addListener) {
    return;
  }

  chromeApi.runtime.onMessage.addListener((message: unknown, sender: ChromeMessageSender, sendResponse: (response: unknown) => void) => {
    if (!isRuntimeMessage(message)) {
      return false;
    }

    void handleMessage(message, sender)
      .then((response) => {
        sendResponse(response);
      })
      .catch((error: unknown) => {
        const geminiRawResponse = getGeminiAppRawResponse(error);
        sendResponse({
          ok: false,
          type: message.type,
          error: toErrorMessage(error),
          ...(geminiRawResponse !== null
            ? {
                errorDetail: {
                  title: 'Gemini 实际回复',
                  content: geminiRawResponse,
                },
              }
            : {}),
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

  // Register context menus for image and screenshot translation.
  if (chromeApi.contextMenus?.create) {
    if (chromeApi.contextMenus.removeAll) {
      chromeApi.contextMenus.removeAll(() => registerContextMenus());
    } else {
      registerContextMenus();
    }
    chromeApi.contextMenus.onClicked?.addListener((info, tab) => {
      if (typeof tab?.id !== 'number') return;
      if (info.menuItemId === 'translate-image') {
        sendTabMessage(tab.id, { type: 'mt:context-menu-translate' });
      } else if (info.menuItemId === 'translate-screenshot') {
        sendTabMessage(tab.id, { type: 'mt:start-screenshot-translate' });
      }
    });
  }

  chromeApi.commands?.onCommand?.addListener((command, tab) => {
    if (typeof tab?.id !== 'number') return;
    if (command === startScreenshotTranslateCommand) {
      sendTabMessage(tab.id, { type: 'mt:start-screenshot-translate' });
      return;
    }
    if (command === translateHoverTargetCommand) {
      sendTabMessage(tab.id, { type: 'mt:shortcut-translate-hover' });
    }
  });
}

void initializeBackground();
