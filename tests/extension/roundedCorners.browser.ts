import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, firefox, expect, type Page } from '@playwright/test';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cn } from '../../apps/extension/src/popup/lib/utils';

// Run with: npm run check:rounded-corners
const outputDirectory = resolve('artifacts/rounded-corners');
await mkdir(outputDirectory, { recursive: true });
const fixtureSource = (): Plugin => ({
  name: 'corner-regression-fixture-source',
  enforce: 'pre',
  transform: {
    order: 'pre',
    handler(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/styles.css')
        && !id.replaceAll('\\', '/').endsWith('/popup/styles.css')) return;
      return `${source}\n@source inline("rounded-[2px] rounded-[24px] rounded-[8px] rounded-full rounded-concentric rounded-concentric-[6px] rounded-concentric-[4px] p-[4px] p-[2px] concentric-squircle");`;
    },
  },
});
const popupServer = await createServer({
  configFile: false,
  root: resolve('.'),
  publicDir: resolve('public'),
  plugins: [fixtureSource(), react(), tailwindcss()],
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, watch: null },
});
const webServer = await createServer({
  configFile: resolve('apps/web/vite.config.ts'),
  root: resolve('apps/web'),
  plugins: [fixtureSource()],
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, watch: null },
});

async function origin(server: ViteDevServer): Promise<string> {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Preview server did not start');
  return `http://127.0.0.1:${address.port}`;
}

async function checkConcentric(page: Page, parentSelector: string, childSelector: string) {
  const children = page.locator(childSelector);
  expect(await children.count(), childSelector).toBeGreaterThan(0);
  const radii = await children.evaluateAll((elements, parentSelector) => elements.map((element) => {
    const parent = element.closest(parentSelector);
    if (!parent) throw new Error(`Missing concentric parent: ${parentSelector}`);
    const outer = getComputedStyle(parent);
    const inner = getComputedStyle(element);
    return {
      element: element.className,
      actual: parseFloat(inner.borderTopLeftRadius),
      expected: Math.max(0, parseFloat(outer.borderTopLeftRadius)
        - (parseFloat(outer.borderLeftWidth) + parseFloat(outer.paddingLeft))
          * (CSS.supports('corner-shape', 'squircle') ? 1.8409 : 1)),
    };
  }), parentSelector);
  for (const { element, actual, expected } of radii) expect(actual, element).toBeCloseTo(expected, 3);
}

async function checkShape(page: Page, selector: string, shape: string) {
  const supported = await page.evaluate(() => CSS.supports('corner-shape', 'squircle'));
  const element = page.locator(selector).first();
  await expect(element).toHaveCount(1);
  expect(await element.evaluate((el) => getComputedStyle(el).getPropertyValue('corner-shape')))
    .toBe(supported ? shape : '');
}

async function checkClampAndIsolation(page: Page) {
  const radii = await page.evaluate(() => {
    const fixture = document.createElement('div');
    fixture.innerHTML = `
      <div class="rounded-[2px] concentric-squircle">
        <div class="corner-clamp rounded-concentric-[6px] concentric-squircle"></div>
      </div>
      <div class="rounded-[24px] p-[4px] concentric-squircle">
        <div class="corner-child rounded-concentric p-[2px] concentric-squircle">
          <div class="corner-grandchild rounded-concentric concentric-squircle"></div>
          <div class="rounded-[8px] p-[2px] concentric-squircle">
            <div class="corner-reset rounded-concentric concentric-squircle"></div>
          </div>
        </div>
      </div>
      <div class="rounded-full p-[2px]" style="corner-shape:round">
        <div class="corner-pill rounded-concentric" style="corner-shape:round"></div>
      </div>`;
    document.body.append(fixture);
    const factor = CSS.supports('corner-shape', 'squircle') ? 1.8409 : 1;
    const values = Array.from(fixture.querySelectorAll('.corner-clamp, .corner-child, .corner-grandchild, .corner-reset, .corner-pill'), (el) =>
      parseFloat(getComputedStyle(el).borderTopLeftRadius));
    fixture.remove();
    return { values, factor };
  });
  const { values, factor } = radii;
  expect(values[0]).toBe(0);
  expect(values[1]).toBeCloseTo(24 - 4 * factor, 3);
  expect(values[2]).toBeCloseTo(24 - 6 * factor, 3);
  expect(values[3]).toBeCloseTo(8 - 2 * factor, 3);
  expect(values[4]).toBeGreaterThan(1000);
}

async function checkContentCorners(page: Page) {
  await page.evaluate(async () => {
    const source = '/apps/extension/src/content/core/ui/styles.ts';
    const { injectStyles } = await import(source);
    injectStyles();
    const fixture = document.createElement('div');
    fixture.id = 'content-corner-fixture';
    fixture.innerHTML = `
      <div class="mt-x-stage-card mt:rounded-(--mt-stage-card-radius) mt:concentric-squircle" data-visible="true" data-expanded="true">
        <button class="mt-x-stage-card-toggle mt:rounded-concentric-[1px] mt:concentric-squircle">Progress</button>
        <div class="mt-x-stage-card-body">
          <div class="mt-x-runtime-node mt:rounded-concentric-[11px] mt:concentric-squircle"><span class="mt-x-runtime-dot"></span>OCR</div>
          <pre class="mt-x-error-detail-content mt:rounded-concentric-[11px] mt:concentric-squircle">Details</pre>
        </div>
      </div>
      <button class="mt-x-control">Translate</button>
      <div class="host-page-radius rounded-md">Host utility</div>
      <div class="host-page-rounded-box" style="border-radius:12px">Host page</div>`;
    document.body.append(fixture);
  });
  const factor = await page.evaluate(() => CSS.supports('corner-shape', 'squircle') ? 1.8409 : 1);
  const radius = async (selector: string) => page.locator(selector).evaluate((el) =>
    parseFloat(getComputedStyle(el).borderTopLeftRadius));
  const outerRadius = await radius('.mt-x-stage-card');
  expect(outerRadius).toBeGreaterThan(0);
  expect(await radius('.mt-x-stage-card-toggle')).toBeCloseTo(outerRadius - factor, 3);
  await expect(page.locator('.mt-x-stage-card-toggle')).toHaveCSS('border-bottom-left-radius', '0px');
  expect(await radius('.mt-x-runtime-node')).toBeCloseTo(Math.max(0, outerRadius - 11 * factor), 3);
  expect(await radius('.mt-x-error-detail-content')).toBeCloseTo(Math.max(0, outerRadius - 11 * factor), 3);
  await checkShape(page, '.mt-x-stage-card-toggle', 'squircle');
  await checkShape(page, '.mt-x-runtime-node', 'squircle');
  await checkShape(page, '.mt-x-runtime-dot', 'round');
  await checkShape(page, '.mt-x-control', 'round');
  await checkShape(page, '.host-page-radius', 'round');
  await checkShape(page, '.host-page-rounded-box', 'round');
  await expect(page.locator('.host-page-radius')).toHaveCSS('border-top-left-radius', '0px');
  await expect(page.locator('.host-page-rounded-box')).toHaveCSS('border-top-left-radius', '12px');
  await page.locator('#content-corner-fixture').evaluate((el) => el.remove());
}

try {
  expect(cn('rounded-md', 'rounded-concentric-[4px]', 'concentric-squircle'))
    .toBe('rounded-concentric-[4px] concentric-squircle');
  const popupOrigin = await origin(popupServer);
  const webOrigin = await origin(webServer);
  for (const [browserName, browserType] of Object.entries({ chromium, firefox })) {
    const browser = await browserType.launch();
    try {
      const popup = await browser.newPage({ viewport: { width: 380, height: 600 } });
      await popup.goto(`${popupOrigin}/tests/extension/fixtures/popupPreview.html?state=deepseek&debug=1`);
      await expect(popup.locator('.seg-control').first()).toBeVisible();
      await checkConcentric(popup, '.seg-control', '.seg-pill, .seg-option');
      await checkShape(popup, '.seg-control', 'squircle');
      await checkShape(popup, '.mode-options-affordance', 'round');
      await checkClampAndIsolation(popup);
      await popup.getByRole('button', { name: '模式选项', exact: true }).click();
      await checkShape(popup, '[data-slot="switch"]', 'round');
      await checkShape(popup, '[data-slot="switch-thumb"]', 'round');
      await popup.keyboard.press('Escape');
      await popup.getByRole('combobox').first().click();
      await expect(popup.locator('.select-menu')).toBeVisible();
      const optionRadius = await popup.locator('.select-option').first().evaluate((el) => {
        const menu = el.closest('.select-menu')!;
        const viewport = menu.querySelector('[data-radix-select-viewport]')!;
        const outer = getComputedStyle(menu);
        return {
          actual: parseFloat(getComputedStyle(el).borderTopLeftRadius),
          expected: Math.max(0, parseFloat(outer.borderTopLeftRadius)
            - (parseFloat(outer.borderLeftWidth) + parseFloat(getComputedStyle(viewport).paddingLeft))
              * (CSS.supports('corner-shape', 'squircle') ? 1.8409 : 1)),
        };
      });
      expect(optionRadius.actual).toBeCloseTo(optionRadius.expected, 3);
      await checkShape(popup, '.select-option', 'squircle');
      await popup.screenshot({ path: resolve(outputDirectory, `${browserName}-popup.png`), animations: 'disabled' });
      const content = await browser.newPage();
      await content.route('**/__corner-content', (route) => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
      }));
      await content.goto(`${popupOrigin}/__corner-content`);
      await checkContentCorners(content);

      const web = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await web.goto(webOrigin);
      await expect(web.locator('.preview-tabs')).toBeVisible();
      await expect(web.locator('#web-image-import')).toBeEnabled({ timeout: 30_000 });
      const png = await web.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 600;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#fff8fb';
        context.fillRect(0, 0, 400, 600);
        context.fillStyle = '#6b4455';
        context.font = '24px sans-serif';
        context.fillText('Corner preview', 32, 64);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      await web.locator('#web-image-import').setInputFiles({
        name: 'corner-preview.png',
        mimeType: 'image/png',
        buffer: Buffer.from(png, 'base64'),
      });
      await expect(web.locator('.preview-toolbar')).toBeVisible();
      await checkConcentric(web, '.locale-switch', '.locale-switch button');
      await checkConcentric(web, '.preview-tabs', '.preview-tab-indicator, .preview-tabs button');
      await checkConcentric(web, '.preview-toolbar', '.preview-toolbar button');
      await checkConcentric(web, '.segmented-control', '.segmented-indicator, .segmented-control button');
      await checkShape(web, '.preview-toolbar', 'squircle');
      await checkShape(web, '.web-badge', 'round');
      await checkClampAndIsolation(web);
      await web.screenshot({ path: resolve(outputDirectory, `${browserName}-web.png`), animations: 'disabled' });
      const supportsSmoothing = await web.evaluate(() => CSS.supports('corner-shape', 'squircle'));
      console.log(`${browserName}: popup, web, and content corner checks passed; native smoothing: ${supportsSmoothing}.`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await popupServer.close();
  await webServer.close();
}
