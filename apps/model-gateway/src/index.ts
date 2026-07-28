import {
  MODEL_GATEWAY_ALLOWLIST,
  modelR2Key,
  type ModelPackageAsset,
} from '@shinobu/model-manifest';

export type ModelObject = {
  size: number;
  httpEtag: string;
  body?: ReadableStream<Uint8Array>;
};

export type ModelBucket = {
  head(key: string): Promise<ModelObject | null>;
  get(
    key: string,
    options?: { range?: { offset?: number; length?: number; suffix?: number } },
  ): Promise<ModelObject | null>;
};

export type ModelGatewayEnv = {
  MODELS: ModelBucket;
  ALLOWED_ORIGIN: string;
  SERVING_ENABLED: string;
  TURNSTILE_REQUIRED?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_HOSTNAME?: string;
};

type Fetcher = typeof fetch;

type ByteRange = {
  offset: number;
  length: number;
  end: number;
};

type RangeResult =
  | { ok: true; range?: ByteRange }
  | { ok: false; status: 400 | 416 };

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const ALLOWED_REQUEST_HEADERS = new Set(['range', 'x-shinobu-turnstile']);

function parseRange(value: string | null, size: number): RangeResult {
  if (value === null) return { ok: true };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return { ok: false, status: 400 };

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false, status: 416 };
    const length = Math.min(suffix, size);
    return {
      ok: true,
      range: {
        offset: size - length,
        length,
        end: size - 1,
      },
    };
  }

  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(requestedEnd)
    || offset >= size
    || requestedEnd < offset
  ) {
    return { ok: false, status: 416 };
  }
  const end = Math.min(requestedEnd, size - 1);
  return {
    ok: true,
    range: {
      offset,
      length: end - offset + 1,
      end,
    },
  };
}

function corsHeaders(origin: string): Headers {
  const headers = new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    Vary: 'Origin',
  });
  return headers;
}

function response(
  status: number,
  message: string,
  origin?: string,
  env?: ModelGatewayEnv,
  extra?: HeadersInit,
): Response {
  const headers = origin && env ? corsHeaders(origin) : new Headers();
  headers.set('Content-Type', 'text/plain;charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(message, { status, headers });
}

function validOrigin(request: Request, env: ModelGatewayEnv): string | null {
  const configured = env.ALLOWED_ORIGIN.trim().replace(/\/+$/u, '');
  const origin = request.headers.get('Origin');
  return configured && origin === configured ? origin : null;
}

function preflight(request: Request, env: ModelGatewayEnv, origin: string): Response {
  const method = request.headers.get('Access-Control-Request-Method');
  if (method !== 'GET' && method !== 'HEAD') {
    return response(405, 'Method not allowed', origin, env, { Allow: 'GET, HEAD, OPTIONS' });
  }
  const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((header) => !ALLOWED_REQUEST_HEADERS.has(header))) {
    return response(400, 'Request header not allowed', origin, env);
  }
  const headers = corsHeaders(origin);
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Range, X-Shinobu-Turnstile');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(null, { status: 204, headers });
}

async function validateTurnstile(
  request: Request,
  env: ModelGatewayEnv,
  fetcher: Fetcher,
): Promise<boolean> {
  if (env.TURNSTILE_REQUIRED !== 'true') return true;
  const token = request.headers.get('X-Shinobu-Turnstile');
  if (!env.TURNSTILE_SECRET || !token || token.length > 2_048) return false;

  try {
    const verification = await fetcher(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: request.headers.get('CF-Connecting-IP') ?? undefined,
      }),
    });
    if (!verification.ok) return false;
    const result = await verification.json() as { success?: unknown; hostname?: unknown };
    return result.success === true
      && (
        !env.TURNSTILE_HOSTNAME
        || result.hostname === env.TURNSTILE_HOSTNAME
      );
  } catch {
    return false;
  }
}

function modelHeaders(
  asset: ModelPackageAsset,
  object: ModelObject,
  origin: string,
  range?: ByteRange,
): Headers {
  const headers = corsHeaders(origin);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Content-Type', asset.mediaType);
  headers.set('Content-Length', String(range?.length ?? asset.size));
  headers.set('ETag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.end}/${asset.size}`);
  }
  return headers;
}

export async function handleModelRequest(
  request: Request,
  env: ModelGatewayEnv,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  if (env.SERVING_ENABLED !== 'true') {
    return response(503, 'Model delivery is temporarily disabled');
  }

  const url = new URL(request.url);
  if (url.search) return response(400, 'Query parameters are not allowed');
  const asset = MODEL_GATEWAY_ALLOWLIST.get(url.pathname);
  if (!asset) return response(404, 'Not found');

  const origin = validOrigin(request, env);
  if (!origin) return response(403, 'Origin not allowed');
  if (request.method === 'OPTIONS') return preflight(request, env, origin);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return response(405, 'Method not allowed', origin, env, { Allow: 'GET, HEAD, OPTIONS' });
  }
  if (!await validateTurnstile(request, env, fetcher)) {
    return response(403, 'Verification required', origin, env);
  }

  const parsedRange = parseRange(request.headers.get('Range'), asset.size);
  if (!parsedRange.ok) {
    return response(
      parsedRange.status,
      parsedRange.status === 416 ? 'Range not satisfiable' : 'Malformed Range',
      origin,
      env,
      parsedRange.status === 416 ? { 'Content-Range': `bytes */${asset.size}` } : undefined,
    );
  }

  try {
    const key = modelR2Key(asset);
    const object = request.method === 'HEAD'
      ? await env.MODELS.head(key)
      : await env.MODELS.get(
        key,
        parsedRange.range
          ? {
              range: {
                offset: parsedRange.range.offset,
                length: parsedRange.range.length,
              },
            }
          : undefined,
      );
    if (
      !object
      || object.size !== asset.size
      || (request.method === 'GET' && !object.body)
    ) {
      return response(503, 'Model object is unavailable', origin, env);
    }
    return new Response(
      request.method === 'HEAD' ? null : object.body,
      {
        status: parsedRange.range ? 206 : 200,
        headers: modelHeaders(asset, object, origin, parsedRange.range),
      },
    );
  } catch {
    return response(503, 'Model storage is unavailable', origin, env);
  }
}

export default {
  fetch(request: Request, env: ModelGatewayEnv): Promise<Response> {
    return handleModelRequest(request, env);
  },
};
