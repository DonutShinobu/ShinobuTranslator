import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const serviceWorkerSource = readFileSync(
  new URL('../../public/sw.js', import.meta.url),
  'utf8',
);

type CachePolicy = (
  request: { method: string; mode: string; destination: string },
  url: URL,
) => boolean;

function loadCachePolicy(): CachePolicy {
  const context = vm.createContext({
    URL,
    self: {
      location: { origin: 'https://shinobu.example' },
      registration: {},
      clients: {},
      addEventListener() {},
    },
    caches: {},
    fetch() {},
  });
  vm.runInContext(serviceWorkerSource, context);
  return vm.runInContext('isCacheableStaticRequest', context) as CachePolicy;
}

function request(
  destination: string,
  method = 'GET',
  mode = 'cors',
): { method: string; mode: string; destination: string } {
  return { method, mode, destination };
}

describe('PWA release assets', () => {
  it('caches only same-origin app shell resources and never translation or model requests', () => {
    const isCacheable = loadCachePolicy();

    expect(isCacheable(
      request('script'),
      new URL('https://shinobu.example/assets/app.js'),
    )).toBe(true);
    expect(isCacheable(
      request(''),
      new URL('https://shinobu.example/runtime.wasm'),
    )).toBe(true);
    expect(isCacheable(
      request('', 'GET'),
      new URL('https://shinobu.example/v1/chat/completions'),
    )).toBe(false);
    expect(isCacheable(
      request('script', 'POST'),
      new URL('https://shinobu.example/assets/app.js'),
    )).toBe(false);
    expect(isCacheable(
      request('script'),
      new URL('https://provider.example/assets/app.js'),
    )).toBe(false);
    expect(isCacheable(
      request(''),
      new URL('https://shinobu.example/models/detector.ort'),
    )).toBe(false);
  });

  it('ships a scoped standalone manifest without requesting identity or account features', () => {
    const manifest = JSON.parse(readFileSync(
      new URL('../../public/manifest.webmanifest', import.meta.url),
      'utf8',
    )) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    expect(manifest).not.toHaveProperty('share_target');
    expect(manifest).not.toHaveProperty('protocol_handlers');
    expect(manifest.icons).toContainEqual(expect.objectContaining({
      sizes: 'any',
      type: 'image/svg+xml',
    }));
  });
});
