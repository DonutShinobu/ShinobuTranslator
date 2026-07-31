import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Builder,
  type WebDriver,
} from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import type {
  ConformanceDriverResult,
  ConformanceObservation,
} from '../types';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const packagePath = resolve(
  repositoryRoot,
  'apps/extension/dist/conformance/firefox',
);

type FirefoxDriver = WebDriver & {
  setContext(context: string): Promise<void>;
  installAddon(path: string, temporary: boolean): Promise<string>;
};

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveFirefoxExecutable(): Promise<string | undefined> {
  const candidates = [
    process.env.FIREFOX_BINARY,
    process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, 'Mozilla Firefox/firefox.exe')
      : undefined,
    process.env['PROGRAMFILES(X86)']
      ? join(process.env['PROGRAMFILES(X86)'], 'Mozilla Firefox/firefox.exe')
      : undefined,
    process.platform === 'darwin'
      ? '/Applications/Firefox.app/Contents/MacOS/firefox'
      : undefined,
    process.platform === 'linux' ? '/usr/bin/firefox' : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && await isReadable(candidate)) return candidate;
  }
  return undefined;
}

async function extensionUrl(
  driver: FirefoxDriver,
  addonId: string,
  path: string,
): Promise<string> {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeScript<string>(
      `
        const policy = WebExtensionPolicy.getByID(arguments[0]);
        return policy?.getURL(arguments[1]) || '';
      `,
      addonId,
      path,
    );
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

export async function runFirefoxConformanceDriver():
Promise<ConformanceDriverResult> {
  if (!await isReadable(join(packagePath, 'manifest.json'))) {
    throw new Error(
      `Firefox conformance package is missing: ${packagePath}`,
    );
  }
  const options = new firefox.Options();
  options.addArguments(
    ...(process.env.FIREFOX_HEADLESS === 'true' ? ['-headless'] : []),
    '--width=1280',
    '--height=900',
  );
  options.enableBidi();
  options.setPreference('browser.shell.checkDefaultBrowser', false);
  options.setPreference('remote.system-access-check.enabled', false);
  options.setPreference('extensions.autoDisableScopes', 0);
  options.setPreference('dom.webgpu.enabled', true);
  options.setPreference('gfx.webgpu.force-enabled', true);
  options.setPreference('gfx.webrender.all', true);
  options.setPreference('layers.acceleration.force-enabled', true);
  const binary = await resolveFirefoxExecutable();
  if (binary) options.setBinary(binary);
  const service = new firefox.ServiceBuilder()
    .addArguments('--allow-system-access');
  const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build() as FirefoxDriver;
  try {
    const addonId = await driver.installAddon(packagePath, true);
    if (addonId !== 'shinobu-translator@donutshinobu') {
      throw new Error(`Unexpected Firefox add-on ID: ${addonId}`);
    }
    const handlesBefore = await driver.getAllWindowHandles();
    const url = await extensionUrl(driver, addonId, 'conformance.html');
    if (!url) throw new Error('Firefox conformance page URL is unavailable');
    await driver.get(url);
    await driver.manage().setTimeouts({ script: 10 * 60_000 });
    try {
      await driver.wait(
        async () => await driver.executeScript<string>(
          'return document.body.dataset.state || "";',
        ) !== 'running',
        10 * 60_000,
        'Firefox conformance probe timed out.',
      );
    } catch (error) {
      const diagnostic = await driver.executeScript<string>(
        'return document.body.textContent || "";',
      );
      throw new Error(
        `Firefox conformance probe timed out: ${diagnostic || 'no progress'}`,
        { cause: error },
      );
    }
    const state = await driver.executeScript<string>(
      'return document.body.dataset.state || "";',
    );
    const payload = await driver.executeScript<string>(
      'return document.body.textContent || "";',
    );
    if (state !== 'complete' || !payload) {
      throw new Error(`Firefox conformance probe failed: ${payload || state}`);
    }
    if ((await driver.getAllWindowHandles()).length !== handlesBefore.length) {
      throw new Error(
        'Firefox conformance created a dedicated pipeline host page.',
      );
    }
    const observations = JSON.parse(payload) as ConformanceObservation[];
    if (
      !Array.isArray(observations)
      || observations.length !== 9
      || observations.some((observation) =>
        observation.browser !== 'firefox'
        || observation.host !== 'event-page-direct')
    ) {
      throw new Error('Firefox driver received an invalid observation matrix');
    }
    const capabilities = await driver.getCapabilities();
    return {
      observations,
      browserVersion: String(
        capabilities.get('browserVersion') ?? 'unknown',
      ),
      packagePath,
    };
  } finally {
    await driver.quit();
  }
}
