export const openAiOAuthIssuer = 'https://auth.openai.com';
export const openAiOAuthClientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const openAiOAuthScope = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
export const openAiOAuthOriginator = 'shinobu_translator';
export const openAiOAuthLoopbackRedirectUri = 'http://localhost:1457/auth/callback';
export const openAiOAuthTokenEndpoint = `${openAiOAuthIssuer}/oauth/token`;
export const openAiOAuthRevokeEndpoint = `${openAiOAuthIssuer}/oauth/revoke`;
export const openAiOAuthRefreshWindowMs = 5 * 60 * 1000;

const defaultAccessTokenTtlMs = 60 * 60 * 1000;
const permanentOpenAiOAuthRefreshErrorCodes = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
]);

export type OpenAiOAuthTokenResponse = {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
};

export type StoredOpenAiOAuthTokens = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string | null;
  email: string | null;
  planType: string | null;
  expiresAt: number;
  lastRefresh: number;
};

export type OpenAiOAuthStatusInfo = {
  authenticated: boolean;
  pending?: boolean;
  email?: string;
  accountId?: string;
  planType?: string;
  expiresAt?: number;
  error?: string;
};

export type BuildOpenAiAuthorizeUrlOptions = {
  redirectUri: string;
  codeChallenge: string;
  state: string;
  clientId?: string;
  originator?: string;
  scope?: string;
};

export type OpenAiOAuthCallbackResult =
  | {
      code: string;
      state: string;
    }
  | {
      error: string;
      errorDescription?: string;
      state?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numericValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function openAiOAuthErrorCode(data: unknown): string | null {
  if (!isRecord(data)) {
    return null;
  }
  const error = data.error;
  if (isRecord(error) && typeof error.code === 'string') {
    return error.code;
  }
  if (typeof data.code === 'string') {
    return data.code;
  }
  if (typeof error === 'string') {
    return error;
  }
  return null;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1];
  if (!payload) {
    return {};
  }

  try {
    const json = new TextDecoder().decode(base64UrlToBytes(payload));
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function buildOpenAiAuthorizeUrl({
  clientId = openAiOAuthClientId,
  redirectUri,
  codeChallenge,
  state,
  originator = openAiOAuthOriginator,
  scope = openAiOAuthScope,
}: BuildOpenAiAuthorizeUrlOptions): string {
  const url = new URL('/oauth/authorize', openAiOAuthIssuer);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', originator);
  url.searchParams.set('state', state);
  return url.toString();
}

function getOAuthCallbackParam(url: URL, name: string): string | null {
  const queryValue = url.searchParams.get(name);
  if (queryValue) {
    return queryValue;
  }
  if (!url.hash.startsWith('#')) {
    return null;
  }
  return new URLSearchParams(url.hash.slice(1)).get(name);
}

export function parseOpenAiOAuthCallbackUrl(
  rawUrl: string,
  redirectUri = openAiOAuthLoopbackRedirectUri,
): OpenAiOAuthCallbackResult | null {
  try {
    const parsed = new URL(rawUrl);
    const expected = new URL(redirectUri);
    if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname) {
      return null;
    }

    const error = getOAuthCallbackParam(parsed, 'error');
    if (error) {
      const errorDescription = getOAuthCallbackParam(parsed, 'error_description') ?? undefined;
      const state = getOAuthCallbackParam(parsed, 'state') ?? undefined;
      return { error, errorDescription, state };
    }

    const code = getOAuthCallbackParam(parsed, 'code');
    const state = getOAuthCallbackParam(parsed, 'state');
    if (!code || !state) {
      return null;
    }
    return { code, state };
  } catch {
    return null;
  }
}

export function buildOpenAiTokenExpiresAt(accessToken: string, expiresIn?: number, now = Date.now()): number {
  const exp = numericValue(decodeJwtPayload(accessToken).exp);
  if (exp && exp > 0) {
    return exp * 1000;
  }
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return now + expiresIn * 1000;
  }
  return now + defaultAccessTokenTtlMs;
}

export function normalizeOpenAiOAuthTokenResponse(
  response: OpenAiOAuthTokenResponse,
  previousRefreshToken = '',
  now = Date.now(),
): StoredOpenAiOAuthTokens {
  const idToken = stringValue(response.id_token);
  const accessToken = stringValue(response.access_token);
  const refreshToken = stringValue(response.refresh_token) ?? previousRefreshToken;
  if (!idToken || !accessToken || !refreshToken) {
    throw new Error('OpenAI 登录响应缺少必要的令牌');
  }

  const idPayload = decodeJwtPayload(idToken);
  const authClaim = isRecord(idPayload['https://api.openai.com/auth'])
    ? idPayload['https://api.openai.com/auth']
    : {};
  const profileClaim = isRecord(idPayload['https://api.openai.com/profile'])
    ? idPayload['https://api.openai.com/profile']
    : {};
  const expiresIn = numericValue(response.expires_in) ?? undefined;

  return {
    idToken,
    accessToken,
    refreshToken,
    accountId: stringValue(authClaim.chatgpt_account_id) ?? stringValue(authClaim.account_id),
    email: stringValue(idPayload.email) ?? stringValue(profileClaim.email),
    planType: stringValue(authClaim.chatgpt_plan_type) ?? stringValue(authClaim.plan_type),
    expiresAt: buildOpenAiTokenExpiresAt(accessToken, expiresIn, now),
    lastRefresh: now,
  };
}

export function isOpenAiOAuthExpired(
  token: Pick<StoredOpenAiOAuthTokens, 'expiresAt'>,
  now = Date.now(),
): boolean {
  return token.expiresAt - now <= openAiOAuthRefreshWindowMs;
}

export function isOpenAiOAuthRefreshSuperseded(
  current: Pick<StoredOpenAiOAuthTokens, 'refreshToken'> | null,
  refreshSubject: Pick<StoredOpenAiOAuthTokens, 'refreshToken'>,
): boolean {
  return !current || current.refreshToken !== refreshSubject.refreshToken;
}

export function isPermanentOpenAiOAuthRefreshFailure(data: unknown): boolean {
  const code = openAiOAuthErrorCode(data);
  return Boolean(code && permanentOpenAiOAuthRefreshErrorCodes.has(code));
}

export function isStoredOpenAiOAuthTokens(value: unknown): value is StoredOpenAiOAuthTokens {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.idToken === 'string' &&
    typeof value.accessToken === 'string' &&
    typeof value.refreshToken === 'string' &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
  );
}

export function createOpenAiOAuthRandomString(byteLength = 32): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error('当前浏览器不支持 OpenAI 登录所需的安全随机数');
  }
  const bytes = new Uint8Array(byteLength);
  cryptoApi.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function createOpenAiOAuthCodeChallenge(codeVerifier: string): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error('当前浏览器不支持 OpenAI 登录所需的 PKCE');
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return bytesToBase64Url(new Uint8Array(digest));
}
