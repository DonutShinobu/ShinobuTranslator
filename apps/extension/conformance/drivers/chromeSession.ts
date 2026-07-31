import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from '@playwright/test';

export type ChromeConformanceSession = {
  context: BrowserContext;
  browser: Browser;
  cdp: CDPSession;
  extensionId: string;
  page: Page;
};

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

export async function withChromeConformanceSession<T>(
  packagePath: string,
  run: (session: ChromeConformanceSession) => Promise<T>,
): Promise<{ value: T; browserVersion: string }> {
  if (!existsSync(join(packagePath, 'manifest.json'))) {
    throw new Error(`Chrome conformance package is missing: ${packagePath}`);
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
    if (!browser) throw new Error('Chrome browser control session is unavailable');
    const cdp = await browser.newBrowserCDPSession();
    const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', {
      path: packagePath,
    });
    const page = await context.newPage();
    await page.goto(
      `chrome-extension://${extensionId}/conformance.html`,
      { waitUntil: 'load' },
    );
    return {
      value: await run({ context, browser, cdp, extensionId, page }),
      browserVersion: browser.version(),
    };
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
