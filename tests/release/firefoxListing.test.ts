import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { amoJwt, parseChromeListing, syncFirefoxListing } from '../../scripts/sync-firefox-listing';
import { SHINOBU_CHROME_EXTENSION_ID } from '../../scripts/publish-chrome-web-store.mjs';

const release = { tagName: 'v0.8.3', body: '### 修复\n\n- 修复翻译', isDraft: false, isPrerelease: false };
function chromeHtml(id = SHINOBU_CHROME_EXTENSION_ID) {
  const data = [[id, 'https://lh3.googleusercontent.com/icon', 'ShinobuTranslator', null, null, null, 'Summary'],
    null, null, null, null, [[1, 'https://lh3.googleusercontent.com/screenshot']], 'Full description'];
  return `AF_initDataCallback({key: 'ds:0', hash: '2', data:${JSON.stringify(data)}, sideChannel: {}});`;
}

describe('Firefox listing sync', () => {
  it('rejects changed or unrelated Chrome data before any AMO write', () => {
    expect(parseChromeListing(chromeHtml())).toMatchObject({ summary: 'Summary', description: 'Full description' });
    expect(() => parseChromeListing(chromeHtml('other-extension'))).toThrow('Wrong Chrome');
    expect(() => parseChromeListing('<html>login</html>')).toThrow('not found');
    expect(() => parseChromeListing(chromeHtml().replaceAll('lh3.googleusercontent.com', 'untrusted.example'))).toThrow('image host');
    expect(() => parseChromeListing(chromeHtml().replace('[1,"https://lh3.googleusercontent.com/screenshot"]', ''))).toThrow('screenshot');
  });

  it('signs short-lived AMO JWTs with a unique nonce', () => {
    const token = amoJwt('key', 'secret');
    const [header, body, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toMatchObject({ iss: 'key' });
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    expect(claims.exp - claims.iat).toBe(60);
    expect(signature).toBe(createHmac('sha256', 'secret').update(`${header}.${body}`).digest('base64url'));
    expect(amoJwt('key', 'secret')).not.toBe(token);
  });

  it.each([false, true])('syncs fields and notes, preserving previous images on upload failure (%s)', async (failUpload) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let uploadAttempts = 0;
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('chromewebstore.google.com')) return new Response(chromeHtml());
      if (url.includes('googleusercontent.com')) return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/jpeg' } });
      expect((init?.headers as Record<string, string>).Authorization).toMatch(/^JWT /);
      if (init?.method === 'POST' && failUpload) return new Response('', { status: 400 });
      if (init?.method === 'POST' && uploadAttempts++ === 0) return new Response('', { status: 429, headers: { 'retry-after': '2405' } });
      return new Response(JSON.stringify({ guid: 'shinobu-translator@donutshinobu', previews: [{ id: 42 }] }));
    }) as typeof fetch;
    const run = syncFirefoxListing({ release, apiKey: 'key', apiSecret: 'secret', fetchImpl, sleep });
    if (failUpload) await expect(run).rejects.toThrow('HTTP 400');
    else await run;
    const jsonPatches = calls.filter(({ init }) => init?.method === 'PATCH' && typeof init.body === 'string');
    expect(JSON.parse(jsonPatches[0].init!.body as string)).toMatchObject({ description: { 'en-US': 'Full description', 'zh-CN': 'Full description' } });
    expect(jsonPatches[1].url).toContain('/versions/0.8.3/');
    expect(JSON.parse(jsonPatches[1].init!.body as string)).toEqual({ release_notes: { 'en-US': release.body, 'zh-CN': release.body } });
    expect(calls.filter(({ init }) => init?.method === 'DELETE')).toHaveLength(failUpload ? 0 : 1);
    if (!failUpload) {
      expect(calls.at(-1)?.url).toContain('/previews/42/');
      expect(sleep).toHaveBeenCalledWith(2405000);
    }
  });

  it('does not write in dry-run mode and refuses prereleases', async () => {
    const fetchImpl = vi.fn(async (input) => String(input).includes('chromewebstore.google.com')
      ? new Response(chromeHtml())
      : new Response('image', { headers: { 'content-type': 'image/png' } })) as typeof fetch;
    await syncFirefoxListing({ release, dryRun: true, fetchImpl });
    expect(vi.mocked(fetchImpl).mock.calls.every(([url]) => !String(url).includes('addons.mozilla.org'))).toBe(true);
    await expect(syncFirefoxListing({ release: { ...release, isPrerelease: true }, dryRun: true, fetchImpl })).rejects.toThrow('stable');
  });
});
