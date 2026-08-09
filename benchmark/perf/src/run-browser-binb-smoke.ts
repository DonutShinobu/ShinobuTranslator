import { chromium, type Page } from '@playwright/test';
import { loadImage } from 'canvas';
import {
  buildBinbImageRequest,
  createBinbContentClient,
  createBinbDescramblePlan,
  isBinbUrlWithinBase,
  type BinbResourceFetcher,
  type BinbServerType,
} from '../../../apps/extension/src/content/readerEngines/binbContent';

type LiveSite = {
  name: string;
  url: string;
  serverType: BinbServerType;
};

const sites: readonly LiveSite[] = [
  {
    name: 'Comic Cmoa',
    url: 'https://www.cmoa.jp/reader/sample/?title_id=271440&content_id=100002714400006',
    serverType: 0,
  },
  {
    name: 'BookLive',
    url: 'https://booklive.jp/bviewer/s/?cid=517391_001',
    serverType: 1,
  },
  {
    name: 'Kodansha',
    url: 'https://www.kodansha.co.jp/comic/products/0000017065/trial',
    serverType: 2,
  },
];

async function readRoot(page: Page): Promise<{ cid: string; metadataUrl: string; readerUrl: string }> {
  await page.waitForSelector('#content[data-ptbinb]', { timeout: 45_000 });
  return page.$eval('#content[data-ptbinb]', (root) => {
    const readerUrl = location.href;
    const cid = root.getAttribute('data-ptbinb-cid') || new URL(readerUrl).searchParams.get('cid');
    const endpoint = root.getAttribute('data-ptbinb');
    if (!cid || !endpoint) throw new Error('Speed Reader root is missing CID or content API');
    return { cid, metadataUrl: new URL(endpoint, readerUrl).href, readerUrl };
  });
}

function createLiveFetcher(page: Page): BinbResourceFetcher {
  return async (request) => {
    if (!isBinbUrlWithinBase(request.url, request.allowedBaseUrl)) {
      throw new Error('Live request escaped its declared BinB boundary');
    }
    // BrowserContext.request shares the live page's cookie jar while staying
    // outside the page world, matching the extension background fetch path.
    const response = await page.context().request.get(request.url, {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    if (!response.ok()) throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
    return {
      text: await response.text(),
      contentType: response.headers()['content-type'] ?? '',
      sourceUrl: response.url(),
    };
  };
}

async function verifySite(page: Page, site: LiveSite): Promise<void> {
  await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const root = await readRoot(page);
  const client = createBinbContentClient({
    ...root,
    fetchResource: createLiveFetcher(page),
    randomBlock: () => 'ABCDEFGHIJKLMNOP',
  });
  const manifest = await client.read({ forceRefresh: true });
  if (manifest.serverType !== site.serverType) {
    throw new Error(`${site.name}: expected ServerType ${site.serverType}, got ${manifest.serverType}`);
  }
  if (manifest.viewMode !== 2) {
    throw new Error(`${site.name}: live smoke is restricted to anonymous trial ViewMode 2`);
  }
  const firstPage = manifest.pages[0];
  if (!firstPage) throw new Error(`${site.name}: content manifest has no physical image page`);
  const imageRequest = buildBinbImageRequest(manifest, firstPage, 'low');
  const imageResponse = await page.context().request.get(imageRequest.url, {
    failOnStatusCode: false,
    maxRedirects: 0,
    headers: { referer: page.url() },
  });
  if (!imageResponse.ok()) {
    throw new Error(`${site.name}: image request failed with HTTP ${imageResponse.status()}`);
  }
  if (!isBinbUrlWithinBase(imageResponse.url(), imageRequest.allowedBaseUrl)) {
    throw new Error(`${site.name}: image response escaped its declared BinB boundary`);
  }
  const image = await loadImage(await imageResponse.body());
  const plan = createBinbDescramblePlan(
    firstPage.scrambleSourceKey,
    firstPage.scrambleDestinationKey,
    image.width,
    image.height,
  );
  if (plan.outputWidth !== firstPage.width || plan.outputHeight !== firstPage.height) {
    throw new Error(`${site.name}: restored dimensions do not match TTX`);
  }
  console.log(JSON.stringify({
    site: site.name,
    serverType: manifest.serverType,
    viewMode: manifest.viewMode,
    physicalPages: manifest.pages.length,
    scrambleVariant: plan.variant,
    dimensions: `${plan.outputWidth}x${plan.outputHeight}`,
  }));
}

if (process.env.BINB_LIVE_SMOKE !== '1') {
  throw new Error('Set BINB_LIVE_SMOKE=1 to explicitly enable BinB live network checks');
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  for (const site of sites) await verifySite(page, site);
} finally {
  await browser.close();
}
