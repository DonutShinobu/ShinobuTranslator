import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { SHINOBU_CHROME_EXTENSION_ID } from './publish-chrome-web-store.mjs';

const AMO = 'https://addons.mozilla.org/api/v5/addons/addon/shinobu-translator%40donutshinobu/';
const CHROME = `https://chromewebstore.google.com/detail/shinobutranslator/${SHINOBU_CHROME_EXTENSION_ID}`;

type Listing = { name: string; summary: string; description: string; icon: string; screenshots: string[] };
type Release = { tagName: string; body: string; isDraft: boolean; isPrerelease: boolean };
type Preview = { id: number };

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing listing text');
  return value;
}

function imageUrl(value: unknown): string {
  const url = new URL(requiredText(value));
  if (url.protocol !== 'https:' || url.hostname !== 'lh3.googleusercontent.com'
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Unexpected Chrome listing image host');
  }
  return url.href;
}

export function parseChromeListing(html: string): Listing {
  // ponytail: Chrome has no listing read API; fail closed if its embedded JSON layout changes.
  const payload = html.match(/AF_initDataCallback\(\{key: 'ds:0',.*?data:([\s\S]*?), sideChannel:/)?.[1];
  if (!payload) throw new Error('Chrome listing data not found');
  const data = JSON.parse(payload);
  if (data?.[0]?.[0] !== SHINOBU_CHROME_EXTENSION_ID) throw new Error('Wrong Chrome extension');
  if (!Array.isArray(data[5]) || !data[5].length || data[5].length > 10) {
    throw new Error('Chrome screenshot list missing or unexpected');
  }
  const screenshots = data[5].map((media: unknown[]) => {
    if (!Array.isArray(media) || media[0] !== 1) throw new Error('Unsupported Chrome listing media');
    return imageUrl(media[1]);
  });
  const summary = requiredText(data[0][6]);
  if (summary.length > 250) throw new Error('Chrome summary exceeds AMO limit');
  return {
    name: requiredText(data[0][2]), summary,
    description: requiredText(data[6]), icon: imageUrl(data[0][1]), screenshots,
  };
}

export function amoJwt(apiKey: string, apiSecret: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: apiKey, jti: randomUUID(), iat, exp: iat + 60 })}`;
  return `${data}.${createHmac('sha256', apiSecret).update(data).digest('base64url')}`;
}

export async function syncFirefoxListing(options: {
  release: Release;
  apiKey?: string;
  apiSecret?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<void> {
  const { release, apiKey, apiSecret, dryRun } = options;
  if (!/^v\d+\.\d+\.\d+$/.test(release.tagName) || release.isDraft || release.isPrerelease) {
    throw new Error('A stable extension release is required');
  }
  requiredText(release.body);
  if (!dryRun && (!apiKey || !apiSecret)) throw new Error('AMO API credentials are required');
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = async (url: string, init: RequestInit = {}) => {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url}: HTTP ${response.status}`);
    return response;
  };
  const listings: Record<string, Listing> = {};
  for (const locale of ['en-US', 'zh-CN']) {
    listings[locale] = parseChromeListing(await (await request(`${CHROME}?hl=${locale}`)).text());
  }
  const source = listings['zh-CN'];
  const fields = Object.fromEntries(['name', 'summary', 'description'].map((field) => [
    field, Object.fromEntries(Object.entries(listings).map(([locale, listing]) => [locale, listing[field as keyof Listing]])),
  ]));
  // Download and validate every source image before making any AMO changes.
  const downloadImage = async (url: string) => {
    const response = await request(url, { headers: { Accept: 'image/png,image/jpeg' } });
    const type = response.headers.get('content-type')?.split(';')[0];
    if (type !== 'image/png' && type !== 'image/jpeg') throw new Error('AMO requires PNG or JPEG images');
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 10 * 1024 * 1024) throw new Error('Invalid listing image size');
    return new Blob([bytes], { type });
  };
  const icon = await downloadImage(`${source.icon}=s128-rj`);
  const screenshots: Blob[] = [];
  for (const url of source.screenshots) screenshots.push(await downloadImage(`${url}=s0-rj`));
  console.log(JSON.stringify({ release: release.tagName, fields, screenshots: screenshots.length, dryRun: Boolean(dryRun) }, null, 2));
  if (dryRun) return;

  const amo = async (path: string, method = 'GET', body?: object | FormData) => {
    const multipart = body instanceof FormData;
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(`${AMO}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `JWT ${amoJwt(apiKey!, apiSecret!)}`,
          ...(!multipart && body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
      });
      if (response.ok) return response;
      // Retry only explicit throttling; an ambiguous upload failure could have created a preview.
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter === null ? 60 : Number(retryAfter);
      if (response.status !== 429 || attempt >= 3 || !Number.isFinite(seconds) || seconds > 300) {
        throw new Error(`${method} ${AMO}${path}: HTTP ${response.status}; ${(await response.text()).slice(0, 500)}`);
      }
      console.log(`AMO throttled ${method} ${path}; retrying after ${Math.max(1, seconds)}s`);
      await response.arrayBuffer();
      await (options.sleep ?? setTimeout)(Math.max(1, seconds) * 1000);
    }
  };
  const before = await (await amo('')).json();
  if (before.guid !== 'shinobu-translator@donutshinobu' || !Array.isArray(before.previews)
    || before.previews.some((preview: Preview) => !Number.isSafeInteger(preview.id))) {
    throw new Error('Unexpected AMO listing response');
  }
  const versionPath = `versions/${release.tagName.slice(1)}/`;
  await amo(versionPath); // Do not update a listing for a version that was never submitted.
  await amo('', 'PATCH', fields);
  const form = new FormData();
  form.set('icon', icon, icon.type === 'image/png' ? 'icon.png' : 'icon.jpg');
  await amo('', 'PATCH', form);
  await amo(versionPath, 'PATCH', { release_notes: { 'en-US': release.body, 'zh-CN': release.body } });

  // Keep all previous screenshots until every replacement has been accepted.
  for (const [position, screenshot] of screenshots.entries()) {
    const preview = new FormData();
    preview.set('image', screenshot, screenshot.type === 'image/png' ? 'screenshot.png' : 'screenshot.jpg');
    preview.set('position', String(position));
    await amo('previews/', 'POST', preview);
  }
  for (const preview of before.previews as Preview[]) await amo(`previews/${preview.id}/`, 'DELETE');
  console.log(`Firefox listing synced from Chrome; release notes: ${release.tagName}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) throw new Error('Usage: tsx scripts/sync-firefox-listing.ts <release.json> [--dry-run]');
  await syncFirefoxListing({
    release: JSON.parse(await readFile(file, 'utf8')),
    apiKey: process.env.WEB_EXT_API_KEY,
    apiSecret: process.env.WEB_EXT_API_SECRET,
    dryRun: process.argv.includes('--dry-run'),
  });
}
