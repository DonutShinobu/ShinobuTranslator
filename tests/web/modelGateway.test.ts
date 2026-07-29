import { describe, expect, it, vi } from 'vitest';
import {
  buildModelGatewayAllowlist,
  MODEL_PACKAGE,
  modelGatewayPath,
  modelR2Key,
} from '../../packages/model-manifest/src';
import {
  handleModelRequest,
  type ModelBucket,
  type ModelGatewayEnv,
  type ModelObject,
} from '../../apps/model-gateway/src';

const asset = MODEL_PACKAGE.assets[4];
const origin = 'https://shinobu.pages.dev';

describe('model gateway release compatibility', () => {
  it('can retain a previous content-hash package during a Pages rollout', () => {
    const previousAsset = {
      ...MODEL_PACKAGE.assets[0],
      sha256: 'f'.repeat(64),
    };
    const allowlist = buildModelGatewayAllowlist([
      MODEL_PACKAGE,
      {
        ...MODEL_PACKAGE,
        version: 'previous',
        assets: [previousAsset],
      },
    ]);

    expect(allowlist.get(modelGatewayPath(previousAsset))).toEqual(previousAsset);
    expect(allowlist.size).toBe(MODEL_PACKAGE.assets.length + 1);
  });

  it('rejects conflicting metadata for the same content path', () => {
    const current = MODEL_PACKAGE.assets[0];
    expect(() => buildModelGatewayAllowlist([
      MODEL_PACKAGE,
      {
        ...MODEL_PACKAGE,
        version: 'conflict',
        assets: [{ ...current, size: current.size + 1 }],
      },
    ])).toThrow(/Conflicting model gateway asset metadata/u);
  });
});

function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function setup(overrides: Partial<ModelGatewayEnv> = {}) {
  const calls: Array<{ method: 'get' | 'head'; key: string; range?: unknown }> = [];
  const object: ModelObject = {
    size: asset.size,
    httpEtag: '"model-etag"',
    body: stream('model-body'),
  };
  const bucket: ModelBucket = {
    async head(key) {
      calls.push({ method: 'head', key });
      return object;
    },
    async get(key, options) {
      calls.push({ method: 'get', key, range: options?.range });
      return object;
    },
  };
  const env: ModelGatewayEnv = {
    MODELS: bucket,
    ALLOWED_ORIGIN: origin,
    SERVING_ENABLED: 'true',
    TURNSTILE_REQUIRED: 'false',
    ...overrides,
  };
  const url = `https://models.example${modelGatewayPath(asset)}`;
  return { calls, env, object, url };
}

function request(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('Origin', origin);
  return new Request(url, { ...init, headers });
}

describe('Cloudflare model gateway', () => {
  it('fails closed when the serving switch is not explicitly enabled', async () => {
    const { calls, env, url } = setup({ SERVING_ENABLED: 'false' });
    const result = await handleModelRequest(request(url), env);

    expect(result.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('rejects queries, unknown hashes, methods, and other origins before R2', async () => {
    const { calls, env, url } = setup();
    expect((await handleModelRequest(request(`${url}?cache=bypass`), env)).status).toBe(400);
    expect((await handleModelRequest(
      request(url.replace(asset.sha256, '0'.repeat(64))),
      env,
    )).status).toBe(404);
    expect((await handleModelRequest(request(url, { method: 'POST' }), env)).status).toBe(405);
    expect((await handleModelRequest(new Request(url, {
      headers: { Origin: 'https://attacker.example' },
    }), env)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('streams an allowlisted object with one R2 read and immutable CORS headers', async () => {
    const { calls, env, url } = setup();
    const result = await handleModelRequest(request(url), env);

    expect(result.status).toBe(200);
    expect(await result.text()).toBe('model-body');
    expect(calls).toEqual([{ method: 'get', key: modelR2Key(asset), range: undefined }]);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(result.headers.get('Content-Length')).toBe(String(asset.size));
    expect(result.headers.get('ETag')).toBe('"model-etag"');
    expect(result.headers.get('Cache-Control')).toContain('immutable');
  });

  it('uses HEAD without a body and never performs a GET', async () => {
    const { calls, env, url } = setup();
    const result = await handleModelRequest(request(url, { method: 'HEAD' }), env);

    expect(result.status).toBe(200);
    expect(await result.text()).toBe('');
    expect(calls).toEqual([{ method: 'head', key: modelR2Key(asset) }]);
  });

  it.each([
    ['bytes=10-19', { offset: 10, length: 10 }, `bytes 10-19/${asset.size}`],
    ['bytes=10-', { offset: 10, length: asset.size - 10 }, `bytes 10-${asset.size - 1}/${asset.size}`],
    ['bytes=-100', { offset: asset.size - 100, length: 100 }, `bytes ${asset.size - 100}-${asset.size - 1}/${asset.size}`],
  ])('supports one valid Range: %s', async (range, expected, contentRange) => {
    const { calls, env, url } = setup();
    const result = await handleModelRequest(request(url, {
      headers: { Range: range },
    }), env);

    expect(result.status).toBe(206);
    expect(result.headers.get('Content-Range')).toBe(contentRange);
    expect(result.headers.get('Content-Length')).toBe(String(expected.length));
    expect(calls).toEqual([{
      method: 'get',
      key: modelR2Key(asset),
      range: expected,
    }]);
  });

  it.each([
    ['bytes=1-2,4-5', 400],
    ['items=1-2', 400],
    [`bytes=${asset.size}-`, 416],
    ['bytes=10-9', 416],
    ['bytes=-0', 416],
  ])('rejects invalid Range %s before R2', async (range, status) => {
    const { calls, env, url } = setup();
    const result = await handleModelRequest(request(url, {
      headers: { Range: range },
    }), env);

    expect(result.status).toBe(status);
    expect(calls).toEqual([]);
  });

  it('answers constrained CORS preflight without touching R2', async () => {
    const { calls, env, url } = setup();
    const result = await handleModelRequest(request(url, {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'range',
      },
    }), env);

    expect(result.status).toBe(204);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(result.headers.get('Access-Control-Allow-Headers')).toContain('Range');
    expect(calls).toEqual([]);
  });

  it('validates emergency Turnstile tokens before the only R2 read', async () => {
    const { calls, env, url } = setup({
      TURNSTILE_REQUIRED: 'true',
      TURNSTILE_SECRET: 'secret',
      TURNSTILE_HOSTNAME: 'shinobu.pages.dev',
    });
    const verify = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      hostname: 'shinobu.pages.dev',
    }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const result = await handleModelRequest(request(url, {
      headers: { 'X-Shinobu-Turnstile': 'valid-token' },
    }), env, verify);

    expect(result.status).toBe(200);
    expect(verify).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
  });

  it('returns 503 when the allowlisted R2 object has the wrong size', async () => {
    const { calls, env, object, url } = setup();
    object.size -= 1;
    const result = await handleModelRequest(request(url), env);

    expect(result.status).toBe(503);
    expect(calls).toHaveLength(1);
  });
});
