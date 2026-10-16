import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionControlCommand } from '../../apps/extension/src/shared/extensionControl';
import type { RuntimeResponse } from '../../apps/extension/src/shared/messages';

// Run: npx playwright test --config tests/browser/playwright.geminiCookieLoop.config.ts
// The setup builds the real extension background and content bundles without
// the image pipeline's OCR models. Only HTTP responses are mocked.
type CookieEvent = { time: number; name: string; domain: string; cause: string; removed: boolean };
type RequestEvent = { time: number; endpoint: string; serviceWorker: boolean };
type WorkerScope = typeof globalThis & {
  __shinobuCookieEvents: CookieEvent[];
  chrome: {
    cookies: {
      onChanged: {
        addListener(listener: (event: {
          cookie: { name: string; domain: string }; cause: string; removed: boolean;
        }) => void): void;
      };
    };
  };
};
type Harness = {
  context: BrowserContext;
  page: Page;
  worker: Worker;
  requests: RequestEvent[];
  responseCookies: boolean;
  accountStatus: number;
  command(command: ExtensionControlCommand): Promise<RuntimeResponse>;
  cookieEvents(): Promise<CookieEvent[]>;
};

const test = base.extend<{ extension: Harness }>({
  extension: async ({ browserName }, use, testInfo) => {
    test.skip(browserName !== 'chromium', 'Manifest V3 integration test requires Chromium');
    const dist = path.resolve('apps/extension/dist-chromium');
    for (const file of ['manifest.json', 'background-chromium.js', 'cookie-test.html', 'content.js']) {
      expect(existsSync(path.join(dist, file)), `Build Chromium extension first: missing ${file}`).toBe(true);
    }
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
      args: [
        `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
        // DNS is blocked even before Playwright's routing is installed. All
        // Gemini responses below are local fixtures, with no Google login.
        '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
      ],
    });
    const requests: RequestEvent[] = [];
    const completed: Array<{ time: number; path: string }> = [];
    const blocked: string[] = [];
    const pageErrors: string[] = [];
    let harness: Harness | undefined;
    let worker: Worker | undefined;
    try {
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.protocol === 'chrome-extension:') {
          await route.continue();
          return;
        }
        if (url.hostname !== 'gemini.google.com') {
          blocked.push(`${url.origin}${url.pathname}`);
          await route.abort();
          return;
        }
        const endpoint = url.pathname === '/app' ? 'app' : url.searchParams.get('rpcids') ?? url.pathname;
        requests.push({ time: Date.now(), endpoint, serviceWorker: Boolean(route.request().serviceWorker()) });
        // Bound a broken feedback loop without replacing browser event delivery.
        if (requests.length > 12 || !['app', 'otAQ7b'].includes(endpoint)) {
          await route.abort();
          return;
        }
        const accountStatus: unknown[] = Array(15).fill(null);
        accountStatus[14] = harness?.accountStatus ?? 1000;
        await route.fulfill({
          status: 200,
          headers: {
            'content-type': endpoint === 'app' ? 'text/html' : 'application/json',
            ...(harness?.responseCookies ? {
              'set-cookie': `shinobu_response=${requests.length}; Domain=.google.com; Path=/; Secure; HttpOnly; SameSite=None`,
            } : {}),
          },
          body: endpoint === 'app'
            ? '"SNlM0e":"fixture-token","cfb2h":"fixture-build"'
            : JSON.stringify([[null, null, JSON.stringify(accountStatus)]]),
        });
      });
      context.on('requestfinished', request => {
        const url = new URL(request.url());
        if (url.hostname === 'gemini.google.com') {
          completed.push({ time: Date.now(), path: url.pathname });
        }
      });
      worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      await worker.evaluate(() => {
        const scope = globalThis as WorkerScope;
        scope.__shinobuCookieEvents = [];
        scope.chrome.cookies.onChanged.addListener(({ cookie, cause, removed }) => {
          scope.__shinobuCookieEvents.push({
            time: Date.now(), name: cookie.name, domain: cookie.domain, cause, removed,
          });
        });
      });
      const page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(error.message));
      const extensionId = new URL(worker.url()).hostname;
      // A plain extension document sends real runtime messages without Popup
      // effects issuing their own automatic provider-status refreshes.
      await page.goto(`chrome-extension://${extensionId}/cookie-test.html`);
      harness = {
        context, page, worker, requests, responseCookies: false, accountStatus: 1000,
        command: command => page.evaluate(async payload => {
          const api = (globalThis as typeof globalThis & {
            chrome: { runtime: { sendMessage(message: unknown): Promise<RuntimeResponse> } };
          }).chrome;
          return api.runtime.sendMessage({ type: 'mt:extension-control', command: payload });
        }, command),
        cookieEvents: () => worker!.evaluate(() => (globalThis as WorkerScope).__shinobuCookieEvents),
      };
      const initial = await harness.command({ kind: 'read' });
      expect(initial).toMatchObject({
        ok: true,
        result: { projection: { settings: { translator: 'google_web', geminiAppExperimentalEnabled: false } } },
      });
      await use(harness);
    } finally {
      try {
        const tracePath = testInfo.outputPath('browser-cookie-network-trace.json');
        await mkdir(path.dirname(tracePath), { recursive: true });
        await writeFile(tracePath, JSON.stringify({
          browser: context.browser()?.version(),
          responseCookies: harness?.responseCookies,
          requests, completed, blocked, pageErrors,
          cookies: worker ? await worker.evaluate(() => (globalThis as WorkerScope).__shinobuCookieEvents) : [],
        }, null, 2));
        await testInfo.attach('browser-cookie-network-trace', {
          path: tracePath,
          contentType: 'application/json',
        });
      } finally {
        await context.close();
      }
    }
  },
});

async function seedCookie(extension: Harness, domain: string) {
  await extension.context.addCookies([{
    name: 'shinobu_seed', value: '1', domain, path: '/', secure: true, httpOnly: true, sameSite: 'None',
  }]);
  await expect.poll(async () => (await extension.cookieEvents()).some(event => event.name === 'shinobu_seed')).toBe(true);
}

test('startup, configuration reads and unrelated cookies do not contact Gemini', async ({ extension }) => {
  await seedCookie(extension, '.example.com');
  // A bounded observation window is intentional: absence of later traffic is
  // the behavior under test, after the real browser delivered the cookie event.
  await extension.page.waitForTimeout(750);
  expect(extension.requests).toEqual([]);
});

for (const action of ['refresh', 'login'] as const) {
  test(`explicit Gemini ${action} without response cookies finishes after one check`, async ({ extension }) => {
    const result = await extension.command({ kind: 'perform-access', target: 'gemini-app', action });
    expect(result).toMatchObject({ ok: true, result: { projection: { access: { geminiApp: { state: 'ready' } } } } });
    await extension.page.waitForTimeout(750);
    expect(extension.requests.map(request => request.endpoint)).toEqual(['app', 'otAQ7b']);
    expect(extension.requests.every(request => request.serviceWorker)).toBe(true);
  });
}

test('Google cookies must not contact Gemini while the feature is unused', async ({ extension }) => {
  await extension.page.close(); // No extension document or Google page remains open.
  await seedCookie(extension, '.google.com');
  await extension.context.addCookies([{
    name: 'shinobu_seed', value: '2', domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'None',
  }]);
  await extension.context.clearCookies();
  await expect.poll(async () => (await extension.cookieEvents()).filter(event => event.name === 'shinobu_seed').length).toBe(4);
  await new Promise(resolve => setTimeout(resolve, 750));
  expect(extension.requests.map(request => request.endpoint)).toEqual([]);
});

test('response cookies must not trigger another Gemini authorization check', async ({ extension }) => {
  extension.responseCookies = true;
  const result = await extension.command({ kind: 'perform-access', target: 'gemini-app', action: 'refresh' });
  expect(result).toMatchObject({ ok: true, result: { projection: { access: { geminiApp: { state: 'ready' } } } } });
  await expect.poll(async () => (await extension.cookieEvents()).some(event => event.name === 'shinobu_response')).toBe(true);
  await extension.page.close();
  await new Promise(resolve => setTimeout(resolve, 750));
  expect(extension.requests.map(request => request.endpoint)).toEqual(['app', 'otAQ7b']);
});

test('Gemini execution rechecks authorization after cookies are removed', async ({ extension }) => {
  const current = await extension.command({ kind: 'read' });
  if (!current.ok || current.type !== 'mt:extension-control' || current.result.kind !== 'control-projection') {
    throw new Error('Missing extension control projection');
  }
  const projection = current.result.projection;
  expect(await extension.command({
    kind: 'replace-settings', expectedRevision: projection.revision,
    settings: { ...projection.settings, translator: 'llm', llmProvider: 'gemini' },
  })).toMatchObject({ ok: true });
  expect(extension.requests).toEqual([]);
  extension.responseCookies = true;
  expect(await extension.command({ kind: 'prepare-execution' })).toMatchObject({
    ok: true, result: { kind: 'execution-snapshot', snapshot: { wholeImage: { provider: 'gemini-app' } } },
  });
  await extension.page.waitForTimeout(750);
  expect(extension.requests.map(request => request.endpoint)).toEqual(['app', 'otAQ7b']);
  await extension.context.clearCookies();
  await expect.poll(async () => (await extension.cookieEvents()).some(event => event.name === 'shinobu_response' && event.removed)).toBe(true);
  await extension.page.waitForTimeout(750);
  expect(extension.requests).toHaveLength(2);
  extension.accountStatus = 1016;
  expect(await extension.command({ kind: 'prepare-execution' })).toMatchObject({
    ok: false, error: '请先登录 Gemini',
  });
  await extension.page.waitForTimeout(750);
  expect(extension.requests.map(request => request.endpoint)).toEqual(['app', 'otAQ7b', 'app', 'otAQ7b']);
});
