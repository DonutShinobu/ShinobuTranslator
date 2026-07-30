import { createServer, type Server } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
} from '@playwright/test';
import { resolveExtensionBuildTarget } from '../../../apps/extension/scripts/build-targets.mjs';
import type { RuntimeResponse } from '../../../src/shared/messages';

const distDir = resolveExtensionBuildTarget('chrome').absoluteOutDir;
const fixtureBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const fixtureBytes = Buffer.from(fixtureBase64, 'base64');
const pageFixtureHostname = 'reader.shinobu-smoke.test';
const imageFixtureHostname = 'images.shinobu-smoke.test';

type ListeningServer = {
  server: Server;
  origin: string;
  close(): Promise<void>;
};

type ExecutionContextDescription = {
  id: number;
  origin: string;
  auxData?: {
    frameId?: string;
    isDefault?: boolean;
  };
};

type RuntimeEvaluateResult = {
  result: {
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
    };
  };
};

function requireDistAsset(relativePath: string): void {
  const path = join(distDir, relativePath);
  if (!existsSync(path)) {
    throw new Error(`Missing extension artifact: ${path}. Run npm run build first.`);
  }
}

function findChromiumExecutable(): { executablePath: string; label: string } {
  const playwrightRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'ms-playwright')
    : undefined;
  const installedChromium = playwrightRoot && existsSync(playwrightRoot)
    ? readdirSync(playwrightRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .sort((left, right) => right.name.localeCompare(
        left.name,
        undefined,
        { numeric: true },
      ))
      .map((entry) => join(
        playwrightRoot,
        entry.name,
        'chrome-win64',
        'chrome.exe',
      ))
    : [];
  const candidates = [
    process.env.CHROME_PATH,
    chromium.executablePath(),
    ...installedChromium,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  if (!executablePath) {
    throw new Error(
      'Playwright Chromium not found. Run npx playwright install chromium '
      + 'or set CHROME_PATH to a Chrome for Testing/Chromium executable.',
    );
  }
  return {
    executablePath,
    label: process.env.CHROME_PATH
      ? 'CHROME_PATH browser'
      : 'Playwright Chromium',
  };
}

function originWithHostname(origin: string, hostname: string): string {
  const url = new URL(origin);
  url.hostname = hostname;
  return url.origin;
}

function removeTemporaryProfile(userDataDir: string): void {
  const resolvedProfile = resolve(userDataDir);
  const resolvedTempRoot = resolve(tmpdir());
  const relativeProfile = relative(resolvedTempRoot, resolvedProfile);
  if (
    !relativeProfile
    || relativeProfile.startsWith('..')
    || isAbsolute(relativeProfile)
  ) {
    throw new Error(`Refusing to remove profile outside the temp directory: ${resolvedProfile}`);
  }
  rmSync(resolvedProfile, { recursive: true, force: true });
}

async function listen(server: Server): Promise<ListeningServer> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve fixture server address');
  }
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.closeAllConnections?.();
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    }),
  };
}

async function findContentScriptContext(
  page: Page,
  extensionId: string,
): Promise<{ cdp: CDPSession; contextId: number }> {
  const cdp = await page.context().newCDPSession(page);
  const contexts = new Map<number, ExecutionContextDescription>();
  cdp.on('Runtime.executionContextCreated', (event: {
    context: ExecutionContextDescription;
  }) => {
    contexts.set(event.context.id, event.context);
  });
  await cdp.send('Runtime.enable');
  const frameTree = await cdp.send('Page.getFrameTree') as {
    frameTree: { frame: { id: string } };
  };
  const mainFrameId = frameTree.frameTree.frame.id;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    for (const context of contexts.values()) {
      if (context.auxData?.frameId !== mainFrameId || context.auxData.isDefault === true) {
        continue;
      }
      const evaluated = await cdp.send('Runtime.evaluate', {
        contextId: context.id,
        expression: 'globalThis.chrome?.runtime?.id ?? null',
        returnByValue: true,
      }) as RuntimeEvaluateResult;
      if (evaluated.result.value === extensionId) {
        return { cdp, contextId: context.id };
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  await cdp.detach();
  throw new Error(
    `Unable to find Shinobu content-script execution context; observed: ${
      JSON.stringify([...contexts.values()].map((context) => ({
        id: context.id,
        origin: context.origin,
        auxData: context.auxData,
      })))
    }`,
  );
}

async function sendDownloadFromContentScript(
  cdp: CDPSession,
  contextId: number,
  imageUrl: string,
): Promise<RuntimeResponse> {
  const message = {
    type: 'mt:download-image',
    imageUrl,
  };
  const evaluated = await cdp.send('Runtime.evaluate', {
    contextId,
    expression: `(async () => globalThis.chrome.runtime.sendMessage(${JSON.stringify(message)}))()`,
    awaitPromise: true,
    returnByValue: true,
  }) as RuntimeEvaluateResult;
  if (evaluated.exceptionDetails) {
    throw new Error(
      evaluated.exceptionDetails.exception?.description
      ?? evaluated.exceptionDetails.text
      ?? 'Content-script download evaluation failed',
    );
  }
  if (!evaluated.result.value || typeof evaluated.result.value !== 'object') {
    throw new Error(`Download returned an invalid response: ${evaluated.result.description ?? 'undefined'}`);
  }
  return evaluated.result.value as RuntimeResponse;
}

async function main(): Promise<void> {
  for (const artifact of ['manifest.json', 'background.js', 'content.js']) {
    requireDistAsset(artifact);
  }

  const backgroundSource = readFileSync(join(distDir, 'background.js'), 'utf8');
  for (const hostname of [pageFixtureHostname, imageFixtureHostname]) {
    if (backgroundSource.includes(hostname)) {
      throw new Error(`Production background contains a fixture-host special case: ${hostname}`);
    }
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'shinobu-image-download-smoke-'));
  let context: BrowserContext | undefined;
  let imageFixture: ListeningServer | undefined;
  let pageFixture: ListeningServer | undefined;
  try {
    const browser = findChromiumExecutable();
    let expectedReferers = new Set<string>();
    const observedReferers: Array<string | undefined> = [];
    imageFixture = await listen(createServer((request, response) => {
      if (request.url !== '/protected.png') {
        response.writeHead(404).end('not found');
        return;
      }
      observedReferers.push(request.headers.referer);
      if (
        !request.headers.referer
        || !expectedReferers.has(request.headers.referer)
      ) {
        response.writeHead(403, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end('<html>hotlink blocked</html>');
        return;
      }
      response.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
      });
      const responseDelayMs = observedReferers.length === 1 ? 250 : 0;
      setTimeout(() => response.end(fixtureBytes), responseDelayMs);
    }));
    const imageOrigin = originWithHostname(
      imageFixture.origin,
      imageFixtureHostname,
    );
    const imageUrl = `${imageOrigin}/protected.png`;
    pageFixture = await listen(createServer((request, response) => {
      if (request.url === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      if (
        request.url !== '/'
        && request.url !== '/reader-a.html'
        && request.url !== '/reader-b.html'
      ) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'unsafe-url',
        'cache-control': 'no-store',
      });
      response.end(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>Shinobu protected image smoke</title>
  </head>
  <body>
    <img
      id="protected-image"
      src="${imageUrl}"
      alt="protected fixture"
    >
  </body>
</html>`);
    }));
    const pageOrigin = originWithHostname(
      pageFixture.origin,
      pageFixtureHostname,
    );
    const pageUrls = [
      `${pageOrigin}/reader-a.html`,
      `${pageOrigin}/reader-b.html`,
    ];
    expectedReferers = new Set(pageUrls);

    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: browser.executablePath,
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${distDir}`,
        `--load-extension=${distDir}`,
        `--host-resolver-rules=MAP ${pageFixtureHostname} 127.0.0.1, MAP ${imageFixtureHostname} 127.0.0.1`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const serviceWorker = context.serviceWorkers()[0]
      ?? await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(serviceWorker.url()).hostname;
    if (!extensionId) {
      throw new Error(`Unable to resolve extension id from ${serviceWorker.url()}`);
    }
    const trackerEnvironment = await serviceWorker.evaluate(async () => {
      type TrackerChromeApi = {
        webRequest?: {
          onHeadersReceived?: {
            hasListeners(): boolean;
          };
        };
        permissions: {
          contains(details: {
            permissions: string[];
            origins: string[];
          }): Promise<boolean>;
        };
      };
      const chromeApi = (globalThis as typeof globalThis & {
        chrome: TrackerChromeApi;
      }).chrome;
      return {
        hasWebRequestApi: Boolean(chromeApi.webRequest?.onHeadersReceived),
        hasHeadersReceivedListener:
          chromeApi.webRequest?.onHeadersReceived?.hasListeners() ?? false,
        hasRequiredPermission: await chromeApi.permissions.contains({
          permissions: ['webRequest'],
          origins: ['<all_urls>'],
        }),
      };
    });
    if (
      !trackerEnvironment.hasWebRequestApi
      || !trackerEnvironment.hasHeadersReceivedListener
      || !trackerEnvironment.hasRequiredPermission
    ) {
      throw new Error(
        `Referrer-Policy response-header tracker is not ready: ${
          JSON.stringify(trackerEnvironment)
        }`,
      );
    }

    const pages = await Promise.all(pageUrls.map(async (pageUrl) => {
      const page = await context!.newPage();
      page.setDefaultTimeout(30_000);
      await page.goto(pageUrl, { waitUntil: 'load' });
      await page.locator('#protected-image').evaluate((element) => {
        const image = element as HTMLImageElement;
        if (!image.complete || image.naturalWidth <= 0) {
          throw new Error('Fixture image did not load in the page');
        }
      });
      return page;
    }));
    observedReferers.length = 0;

    const contentScriptContexts = await Promise.all(
      pages.map((page) => findContentScriptContext(page, extensionId)),
    );
    let responses: RuntimeResponse[];
    try {
      responses = await Promise.all(contentScriptContexts.map(
        ({ cdp, contextId }) => sendDownloadFromContentScript(
          cdp,
          contextId,
          imageUrl,
        ),
      ));
    } finally {
      await Promise.all(contentScriptContexts.map(({ cdp }) => cdp.detach()));
    }

    const invalidResponse = responses.find((response) => (
      response.ok !== true
      || response.type !== 'mt:download-image'
      || response.base64 !== fixtureBase64
      || response.contentType !== 'image/png'
      || response.sourceUrl !== imageUrl
    ));
    if (invalidResponse) {
      throw new Error(
        `Original-byte download failed: ${JSON.stringify({
          responses,
          expectedReferers: [...expectedReferers],
          observedReferers,
          trackerEnvironment,
        })}`,
      );
    }
    if (
      observedReferers.length !== expectedReferers.size
      || [...observedReferers].sort().join('\n')
        !== [...expectedReferers].sort().join('\n')
    ) {
      throw new Error(
        `Expected one concurrent background request per document Referer ${
          JSON.stringify([...expectedReferers])
        }, received ${
          JSON.stringify(observedReferers)
        }`,
      );
    }

    const remainingRules = await serviceWorker.evaluate(async () => {
      type Rule = { id?: number };
      type DnrApi = {
        getDynamicRules(): Promise<Rule[]>;
        getSessionRules(): Promise<Rule[]>;
      };
      const dnr = (globalThis as typeof globalThis & {
        chrome: { declarativeNetRequest: DnrApi };
      }).chrome.declarativeNetRequest;
      return {
        dynamic: await dnr.getDynamicRules(),
        session: await dnr.getSessionRules(),
      };
    });
    const isImageHeaderOverrideRule = (rule: { id?: number }): boolean => (
      rule.id === 1
      || rule.id === 2
      || (typeof rule.id === 'number' && rule.id >= 1_000_000)
    );
    if (
      remainingRules.dynamic.some(isImageHeaderOverrideRule)
      || remainingRules.session.some(isImageHeaderOverrideRule)
    ) {
      throw new Error(`Image Referer rules leaked after download: ${JSON.stringify(remainingRules)}`);
    }

    console.log(JSON.stringify({
      browser: browser.label,
      extensionId,
      pageUrls,
      imageUrl,
      expectedReferers: [...expectedReferers],
      observedReferers,
      trackerEnvironment,
      fixtureHostSpecialCases: false,
      originalByteCount: fixtureBytes.byteLength,
      concurrentDownloadCount: responses.length,
      contentTypes: responses.map((response) => (
        response.ok && response.type === 'mt:download-image'
        ? response.contentType
        : undefined
      )),
      sourceUrls: responses.map((response) => (
        response.ok && response.type === 'mt:download-image'
        ? response.sourceUrl
        : undefined
      )),
      remainingRules,
    }, null, 2));
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        const servers = [pageFixture, imageFixture]
          .filter((server): server is ListeningServer => Boolean(server));
        await Promise.all(servers.map((server) => server.close()));
      } finally {
        removeTemporaryProfile(userDataDir);
      }
    }
  }
}

await main();
