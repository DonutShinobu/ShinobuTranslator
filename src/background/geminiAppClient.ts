import { buildGeminiImagePrompt, getGeminiAppModelLabel } from '../shared/config';
import type { ExtensionSettings } from '../shared/config';
import type { GeminiAppAuthStatusInfo, GeminiAppImageTranslateMetadata } from '../shared/messages';
import type { StageTiming } from '../types';
import type { GeminiAppModel } from '../types';
import { getChromeApi } from '../shared/chrome';
import { arrayBufferToBase64, toErrorMessage } from '../shared/utils';

type GeminiAppImageTranslateOptions = {
  imageBase64: string;
  contentType: string;
  filename: string;
  settings: ExtensionSettings;
};

export type GeminiAppImageTranslateResult = {
  base64: string;
  contentType: string;
  metadata: GeminiAppImageTranslateMetadata;
};

type GeminiInitContext = {
  accessToken: string;
  buildLabel: string | null;
  sessionId: string | null;
  language: string;
  pushId: string;
  cookieHeader: string | null;
};

type GeminiGeneratedImage = {
  url: string;
  imageId?: string;
};

const geminiAppUrl = 'https://gemini.google.com/app';
const geminiGenerateUrl = 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const geminiBatchUrl = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';
const googleUploadUrl = 'https://content-push.googleapis.com/upload';
const defaultPushId = 'feeds/mcudyrk2a4khkz';
const defaultLanguage = 'zh-CN';
const requestTimeoutMs = 420_000;
const modelHeaderKey = 'x-goog-ext-525001261-jspb';
const plusProModelHeaders: Record<string, string> = {
  [modelHeaderKey]: '[1,null,null,null,"e6fa609c3fa255c0",null,null,0,[4],null,null,4]',
  'x-goog-ext-73010989-jspb': '[0]',
  'x-goog-ext-73010990-jspb': '[0]',
};
const geminiAppModelRequestHeaders: Record<GeminiAppModel, Record<string, string>> = {
  nano_banana_2: {},
  nano_banana_pro: plusProModelHeaders,
};
const cookieNames = new Set([
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-1PSIDTS',
  '__Secure-1PSIDCC',
  '__Secure-3PSID',
  '__Secure-3PSIDTS',
  '__Secure-3PSIDCC',
]);

let geminiAppQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getNestedValue(data: unknown, path: Array<number | string>): unknown {
  let current: unknown = data;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current) || key < 0 || key >= current.length) {
        return undefined;
      }
      current = current[key];
      continue;
    }
    if (!isRecord(current) || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function parseLengthPrefixedFrames(content: string): unknown[] {
  const frames: unknown[] = [];
  let position = 0;
  while (position < content.length) {
    while (position < content.length && /\s/u.test(content[position])) {
      position += 1;
    }
    if (position >= content.length) {
      break;
    }
    const match = /^(\d+)\r?\n/u.exec(content.slice(position));
    if (!match) {
      break;
    }
    const lengthText = match[1];
    const frameLength = Number.parseInt(lengthText, 10);
    if (!Number.isFinite(frameLength) || frameLength <= 0) {
      break;
    }
    const start = position + match[0].length;
    const end = start + frameLength;
    if (end > content.length) {
      break;
    }
    const frameText = content.slice(start, end).trim();
    position = end;
    if (!frameText) {
      continue;
    }
    try {
      const parsed = parseJson(frameText);
      if (Array.isArray(parsed)) {
        frames.push(...parsed);
      } else {
        frames.push(parsed);
      }
    } catch {
      // Ignore partial or non-JSON frames; callers handle missing images/errors.
    }
  }
  return frames;
}

function extractJsonFromResponse(text: string): unknown[] {
  let content = text;
  if (content.startsWith(")]}'")) {
    content = content.slice(4);
  }
  content = content.trimStart();

  const framed = parseLengthPrefixedFrames(content);
  if (framed.length > 0) {
    return framed;
  }

  try {
    const parsed = parseJson(content.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall through to line-by-line JSON.
  }

  const rows: unknown[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = parseJson(trimmed);
      if (Array.isArray(parsed)) {
        rows.push(...parsed);
      } else {
        rows.push(parsed);
      }
    } catch {
      // ignore
    }
  }
  return rows;
}

function stringAt(data: unknown, path: Array<number | string>): string | null {
  const value = getNestedValue(data, path);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberAt(data: unknown, path: Array<number | string>): number | null {
  const value = getNestedValue(data, path);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function extractGeminiResponseErrorCode(text: string): number | null {
  for (const part of extractJsonFromResponse(text)) {
    const code = numberAt(part, [5, 2, 0, 1, 0]);
    if (code) {
      return code;
    }
  }
  return null;
}

function toGeminiErrorMessage(errorCode: number): string {
  if (errorCode === 1037) {
    return 'Gemini App 图片额度可能已用尽，请等待额度重置后再试';
  }
  if (errorCode === 1050 || errorCode === 1052) {
    return 'Gemini App 当前模型不可用，可能是页面协议或账号能力发生变化';
  }
  if (errorCode === 1060) {
    return 'Gemini App 当前账号、地区或网络暂不可用';
  }
  if (errorCode === 1013) {
    return 'Gemini App 临时繁忙，请稍后重试';
  }
  return `Gemini App 请求失败，错误码 ${errorCode}`;
}

function collectGeneratedImagesFromCandidate(candidate: unknown): GeminiGeneratedImage[] {
  const generatedSources = [
    ...asArray(getNestedValue(candidate, [12, 7, 0])),
    ...asArray(getNestedValue(candidate, [12, 0, '8', 0])),
  ];
  const images: GeminiGeneratedImage[] = [];
  for (const imageData of generatedSources) {
    const url = stringAt(imageData, [0, 3, 3]);
    if (!url) {
      continue;
    }
    const imageId = stringAt(imageData, [1, 0]) ?? undefined;
    images.push({ url, imageId });
  }
  return images;
}

export function extractGeminiGeneratedImages(text: string): GeminiGeneratedImage[] {
  const images: GeminiGeneratedImage[] = [];
  for (const part of extractJsonFromResponse(text)) {
    const innerJson = stringAt(part, [2]);
    if (!innerJson) {
      continue;
    }
    let inner: unknown;
    try {
      inner = parseJson(innerJson);
    } catch {
      continue;
    }
    for (const candidate of asArray(getNestedValue(inner, [4]))) {
      images.push(...collectGeneratedImagesFromCandidate(candidate));
    }
  }
  return images;
}

export function parseGeminiAccountStatus(text: string): number | null {
  for (const part of extractJsonFromResponse(text)) {
    const bodyJson = stringAt(part, [2]);
    if (!bodyJson) {
      continue;
    }
    try {
      const body = parseJson(bodyJson);
      const status = numberAt(body, [14]);
      if (status) {
        return status;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function toAccountStatusError(status: number | null): string | null {
  if (!status || status === 1000) {
    return null;
  }
  if (status === 1016) {
    return '请先在 Chrome 中登录 Gemini App';
  }
  if (status === 1060) {
    return 'Gemini App 当前地区不可用';
  }
  if (status === 1040 || status === 1042) {
    return 'Gemini App 需要先在网页端接受最新服务条款';
  }
  if (status === 1054 || status === 1057) {
    return 'Gemini App 当前账号受年龄或监护设置限制';
  }
  if (status === 1021 || status === 1033) {
    return 'Gemini App 当前账号暂不可用';
  }
  return `Gemini App 当前账号状态不可用，状态码 ${status}`;
}

function normalizeGeneratedImageUrl(url: string): string {
  if (url.includes('=s1024-rj')) {
    return url.replace('=s1024-rj', '=s2048-rj');
  }
  if (url.includes('=s2048-rj')) {
    return url;
  }
  return `${url}=s2048-rj`;
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType || 'image/png' });
}

function buildPrompt(settings: ExtensionSettings): string {
  return buildGeminiImagePrompt(settings);
}

export function getGeminiAppModelMetadataLabel(model: GeminiAppModel): string {
  return `Gemini App / ${getGeminiAppModelLabel(model)}`;
}

export function getGeminiAppModelRequestHeaders(model: GeminiAppModel): Record<string, string> {
  return { ...geminiAppModelRequestHeaders[model] };
}

function randomReqId(): number {
  return Math.floor(10_000 + Math.random() * 90_000);
}

function randomUpperUuid(): string {
  return globalThis.crypto?.randomUUID?.().toUpperCase() ?? `${Date.now()}-${Math.random()}`.toUpperCase();
}

function geminiHeaders(cookieHeader: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    Origin: 'https://gemini.google.com',
    Referer: 'https://gemini.google.com/',
  };
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }
  return headers;
}

function withSameDomain(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    'X-Same-Domain': '1',
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = requestTimeoutMs): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      credentials: 'include',
      cache: 'no-store',
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function readTextResponse(response: Response, failureMessage: string): Promise<string> {
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('请先在 Chrome 中登录 Gemini App，或重新打开 Gemini App 刷新登录状态');
    }
    throw new Error(`${failureMessage}: HTTP ${response.status}`);
  }
  return text;
}

function readCookieHeaderForUrl(url: string): Promise<string> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.cookies?.getAll) {
    return Promise.resolve('');
  }
  return new Promise((resolve, reject) => {
    chromeApi.cookies?.getAll?.({ url }, (cookies) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      const pairs = cookies
        .filter((cookie) => cookieNames.has(cookie.name) && cookie.value)
        .map((cookie) => `${cookie.name}=${cookie.value}`);
      resolve(pairs.join('; '));
    });
  });
}

async function readGeminiCookieHeader(authMode: ExtensionSettings['geminiAppAuthMode']): Promise<string | null> {
  if (authMode !== 'cookies_permission') {
    return null;
  }
  const headers = await Promise.all([
    readCookieHeaderForUrl('https://gemini.google.com/'),
    readCookieHeaderForUrl('https://accounts.google.com/'),
  ]);
  const cookiePairs = new Map<string, string>();
  for (const header of headers) {
    for (const pair of header.split(/;\s*/u)) {
      const eq = pair.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const name = pair.slice(0, eq);
      if (cookieNames.has(name) && !cookiePairs.has(name)) {
        cookiePairs.set(name, pair);
      }
    }
  }
  return cookiePairs.size > 0 ? Array.from(cookiePairs.values()).join('; ') : null;
}

async function initializeGemini(settings: ExtensionSettings): Promise<GeminiInitContext> {
  const cookieHeader = await readGeminiCookieHeader(settings.geminiAppAuthMode);
  const response = await fetchWithTimeout(geminiAppUrl, {
    method: 'GET',
    headers: geminiHeaders(cookieHeader),
  }, 30_000);
  const text = await readTextResponse(response, '初始化 Gemini App 失败');
  const accessToken = /"SNlM0e":\s*"(.*?)"/u.exec(text)?.[1] ?? null;
  if (!accessToken) {
    throw new Error('Gemini App 登录状态不可用，请先在 Chrome 中打开 gemini.google.com 完成登录');
  }
  return {
    accessToken,
    buildLabel: /"cfb2h":\s*"(.*?)"/u.exec(text)?.[1] ?? null,
    sessionId: /"FdrFJe":\s*"(.*?)"/u.exec(text)?.[1] ?? null,
    language: /"TuX5cc":\s*"(.*?)"/u.exec(text)?.[1] ?? defaultLanguage,
    pushId: /"qKIAYe":\s*"(.*?)"/u.exec(text)?.[1] ?? defaultPushId,
    cookieHeader,
  };
}

async function batchExecute(context: GeminiInitContext, rpcid: string, payload: string): Promise<string> {
  const params = new URLSearchParams({
    rpcids: rpcid,
    hl: context.language,
    _reqid: String(randomReqId()),
    rt: 'c',
    'source-path': '/app',
  });
  if (context.buildLabel) {
    params.set('bl', context.buildLabel);
  }
  if (context.sessionId) {
    params.set('f.sid', context.sessionId);
  }
  const body = new URLSearchParams({
    at: context.accessToken,
    'f.req': JSON.stringify([[[rpcid, payload, null, 'generic']]]),
  });
  const response = await fetchWithTimeout(`${geminiBatchUrl}?${params.toString()}`, {
    method: 'POST',
    headers: withSameDomain({
      ...geminiHeaders(context.cookieHeader),
      'x-goog-ext-73010989-jspb': '[0]',
    }),
    body,
  }, 45_000);
  return readTextResponse(response, 'Gemini App RPC 请求失败');
}

async function assertAccountAvailable(context: GeminiInitContext): Promise<void> {
  const text = await batchExecute(context, 'otAQ7b', '[]');
  const error = toAccountStatusError(parseGeminiAccountStatus(text));
  if (error) {
    throw new Error(error);
  }
}

async function sendBardActivity(context: GeminiInitContext): Promise<void> {
  try {
    await batchExecute(context, 'ESY5D', '[[["bard_activity_enabled"]]]');
  } catch {
    // Best-effort setup ping; generation can still succeed without it.
  }
}

async function uploadImage(context: GeminiInitContext, image: Blob, filename: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', image, filename);
  const headers: Record<string, string> = {
    Origin: 'https://gemini.google.com',
    Referer: 'https://gemini.google.com/',
    'X-Tenant-Id': 'bard-storage',
    'Push-ID': context.pushId,
  };
  if (context.cookieHeader) {
    headers.Cookie = context.cookieHeader;
  }
  const response = await fetchWithTimeout(googleUploadUrl, {
    method: 'POST',
    headers,
    body: formData,
  }, 120_000);
  const text = await readTextResponse(response, '上传图片到 Gemini App 失败');
  if (!text.trim()) {
    throw new Error('上传图片到 Gemini App 后未返回文件引用');
  }
  return text.trim();
}

function buildGenerateRequest(prompt: string, fileUrl: string, filename: string, uuidValue: string): string {
  const messageContent = [
    prompt,
    0,
    null,
    [[
      [fileUrl],
      filename,
    ]],
    null,
    null,
    0,
  ];
  const req: unknown[] = new Array(69).fill(null);
  req[0] = messageContent;
  req[1] = [defaultLanguage];
  req[2] = ['', '', '', null, null, null, null, null, null, ''];
  req[6] = [1];
  req[7] = 1;
  req[10] = 1;
  req[11] = 0;
  req[17] = [[0]];
  req[18] = 0;
  req[27] = 1;
  req[30] = [4];
  req[41] = [1];
  req[45] = 1;
  req[53] = 0;
  req[59] = uuidValue;
  req[61] = [];
  req[68] = 2;
  return JSON.stringify([null, JSON.stringify(req)]);
}

async function generateImage(
  context: GeminiInitContext,
  prompt: string,
  fileUrl: string,
  filename: string,
  model: GeminiAppModel,
): Promise<string> {
  const uuidValue = randomUpperUuid();
  const params = new URLSearchParams({
    hl: context.language,
    _reqid: String(randomReqId()),
    rt: 'c',
  });
  if (context.buildLabel) {
    params.set('bl', context.buildLabel);
  }
  if (context.sessionId) {
    params.set('f.sid', context.sessionId);
  }
  const headers = withSameDomain({
    ...geminiHeaders(context.cookieHeader),
    ...getGeminiAppModelRequestHeaders(model),
    'x-goog-ext-525005358-jspb': `["${uuidValue}",1]`,
  });
  const body = new URLSearchParams({
    at: context.accessToken,
    'f.req': buildGenerateRequest(prompt, fileUrl, filename, uuidValue),
  });
  const response = await fetchWithTimeout(`${geminiGenerateUrl}?${params.toString()}`, {
    method: 'POST',
    headers,
    body,
  });
  const text = await readTextResponse(response, 'Gemini App 图片生成请求失败');
  const errorCode = extractGeminiResponseErrorCode(text);
  if (errorCode) {
    throw new Error(toGeminiErrorMessage(errorCode));
  }
  return text;
}

async function downloadGeneratedImage(url: string, cookieHeader: string | null): Promise<{
  base64: string;
  contentType: string;
}> {
  const response = await fetchWithTimeout(normalizeGeneratedImageUrl(url), {
    method: 'GET',
    headers: {
      Origin: 'https://gemini.google.com',
      Referer: 'https://gemini.google.com/',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  }, 120_000);
  if (!response.ok) {
    throw new Error(`下载 Gemini App 译图失败: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error('下载 Gemini App 译图失败: 返回空图片');
  }
  return {
    base64: arrayBufferToBase64(buffer),
    contentType: response.headers.get('content-type') ?? 'image/png',
  };
}

async function executeGeminiAppImageTranslate(
  options: GeminiAppImageTranslateOptions,
): Promise<GeminiAppImageTranslateResult> {
  const stageTimings: StageTiming[] = [];
  const timeStage = async <T>(stage: string, label: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      stageTimings.push({ stage, label, durationMs: performance.now() - start });
    }
  };

  const context = await timeStage('gemini_init', 'Gemini App 初始化', () => initializeGemini(options.settings));
  await timeStage('gemini_status', 'Gemini App 状态检查', () => assertAccountAvailable(context));
  await sendBardActivity(context);
  const imageBlob = base64ToBlob(options.imageBase64, options.contentType);
  const fileUrl = await timeStage('gemini_upload', 'Gemini App 上传图片', () =>
    uploadImage(context, imageBlob, options.filename),
  );
  const prompt = buildPrompt(options.settings);
  const responseText = await timeStage('gemini_generate', 'Gemini App 生成译图', () =>
    generateImage(context, prompt, fileUrl, options.filename, options.settings.geminiAppModel),
  );
  const generated = extractGeminiGeneratedImages(responseText);
  const firstImage = generated[0];
  if (!firstImage) {
    throw new Error('Gemini App 未返回可用译图');
  }
  const downloaded = await timeStage('gemini_download', 'Gemini App 下载译图', () =>
    downloadGeneratedImage(firstImage.url, context.cookieHeader),
  );

  return {
    ...downloaded,
    metadata: {
      modelLabel: getGeminiAppModelMetadataLabel(options.settings.geminiAppModel),
      imageUrl: firstImage.url,
      stageTimings,
    },
  };
}

export function runGeminiAppImageTranslate(
  options: GeminiAppImageTranslateOptions,
): Promise<GeminiAppImageTranslateResult> {
  const queued = geminiAppQueue.then(() => executeGeminiAppImageTranslate(options));
  geminiAppQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

export async function getGeminiAppAuthStatus(settings: ExtensionSettings): Promise<GeminiAppAuthStatusInfo> {
  try {
    const context = await initializeGemini(settings);
    await assertAccountAvailable(context);
    return { authenticated: true };
  } catch (error) {
    return {
      authenticated: false,
      error: toErrorMessage(error),
    };
  }
}
