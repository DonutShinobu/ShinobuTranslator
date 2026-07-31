import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import type {
  ConformanceDriverResult,
  ConformanceObservation,
} from '../types';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const packagePath = resolve(
  repositoryRoot,
  'apps/extension/dist/conformance/chrome',
);

function resolveChromeExecutable(): string {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES
      ? join(
          process.env.PROGRAMFILES,
          'Google/Chrome/Application/chrome.exe',
        )
      : undefined,
    process.env['PROGRAMFILES(X86)']
      ? join(
          process.env['PROGRAMFILES(X86)'],
          'Google/Chrome/Application/chrome.exe',
        )
      : undefined,
    process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined,
    process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
  ];
  const executable = candidates.find((candidate) =>
    candidate && existsSync(candidate));
  if (!executable) {
    throw new Error(
      'Google Chrome was not found. Set CHROME_PATH to the Chrome binary.',
    );
  }
  return executable;
}

export async function runChromeConformanceDriver():
Promise<ConformanceDriverResult> {
  if (!existsSync(join(packagePath, 'manifest.json'))) {
    throw new Error(
      `Chrome conformance package is missing: ${packagePath}`,
    );
  }
  const profile = mkdtempSync(join(tmpdir(), 'shinobu-conformance-chrome-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: resolveChromeExecutable(),
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--enable-unsafe-webgpu',
      '--enable-unsafe-extension-debugging',
    ],
  });
  context.setDefaultTimeout(10 * 60_000);
  try {
    const browser = context.browser();
    if (!browser) {
      throw new Error('Chrome browser control session is unavailable');
    }
    const browserCdp = await browser.newBrowserCDPSession();
    const { id: extensionId } = await browserCdp.send(
      'Extensions.loadUnpacked',
      { path: packagePath },
    );
    const page = await context.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/conformance.html`,
      { waitUntil: 'load' },
    );
    try {
      await page.waitForFunction(
        () => document.body.dataset.state !== 'running',
      );
    } catch (error) {
      const diagnostic = await page.locator('body').textContent();
      throw new Error(
        `Chrome conformance probe timed out: ${diagnostic ?? 'no progress'}`,
        { cause: error },
      );
    }
    const state = await page.locator('body').getAttribute('data-state');
    const payload = await page.locator('body').textContent();
    if (state !== 'complete' || !payload) {
      const targets = await browserCdp.send('Target.getTargets');
      const extensionTargets = targets.targetInfos
        .filter((target) => target.url.includes(extensionId))
        .map((target) => ({
          type: target.type,
          url: target.url,
          attached: target.attached,
        }));
      throw new Error(
        `Chrome conformance probe failed: ${payload ?? state}; `
        + `extension targets=${JSON.stringify(extensionTargets)}`,
      );
    }
    const cdp = await context.newCDPSession(page);
    const targets = await cdp.send('Target.getTargets');
    const offscreenTarget = targets.targetInfos.find((target) =>
      target.url === `chrome-extension://${extensionId}/offscreen.html`);
    if (!offscreenTarget) {
      throw new Error(
        'Chrome conformance did not traverse the packaged Offscreen host.',
      );
    }
    const observation = JSON.parse(payload) as ConformanceObservation;
    if (
      observation.browser !== 'chrome'
      || observation.host !== 'broker-offscreen'
    ) {
      throw new Error('Chrome driver received the wrong host observation');
    }
    return {
      observation,
      browserVersion: context.browser()?.version() ?? 'unknown',
      packagePath,
    };
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
