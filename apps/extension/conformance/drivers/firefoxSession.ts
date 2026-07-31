import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { Builder, type WebDriver } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

export type FirefoxDriver = WebDriver & {
  setContext(context: string): Promise<void>;
  installAddon(path: string, temporary: boolean): Promise<string>;
};

export type FirefoxConformanceSession = {
  driver: FirefoxDriver;
  addonId: string;
  handlesBefore: string[];
};

export async function isReadable(path: string): Promise<boolean> {
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
): Promise<string> {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeScript<string>(`
      const policy = WebExtensionPolicy.getByID(arguments[0]);
      return policy?.getURL('conformance.html') || '';
    `, addonId);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

export async function withFirefoxConformanceSession<T>(
  packagePath: string,
  run: (session: FirefoxConformanceSession) => Promise<T>,
): Promise<{ value: T; browserVersion: string }> {
  if (!await isReadable(join(packagePath, 'manifest.json'))) {
    throw new Error(`Firefox conformance package is missing: ${packagePath}`);
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
    const url = await extensionUrl(driver, addonId);
    if (!url) throw new Error('Firefox conformance page URL is unavailable');
    await driver.get(url);
    await driver.manage().setTimeouts({ script: 10 * 60_000 });
    const capabilities = await driver.getCapabilities();
    return {
      value: await run({ driver, addonId, handlesBefore }),
      browserVersion: String(
        capabilities.get('browserVersion') ?? 'unknown',
      ),
    };
  } finally {
    await driver.quit();
  }
}
