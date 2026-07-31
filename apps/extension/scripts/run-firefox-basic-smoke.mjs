#!/usr/bin/env node
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Builder,
  By,
  LogInspector,
  until,
} from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

const extensionRoot = resolve(
  fileURLToPath(new URL('../dist/firefox/', import.meta.url)),
);
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function isAccessible(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveFirefoxBinary() {
  if (process.env.FIREFOX_BINARY) {
    if (!await isAccessible(process.env.FIREFOX_BINARY)) {
      throw new Error(
        `FIREFOX_BINARY is not readable: ${process.env.FIREFOX_BINARY}`,
      );
    }
    return process.env.FIREFOX_BINARY;
  }

  const candidates = process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES
          ? join(process.env.PROGRAMFILES, 'Mozilla Firefox', 'firefox.exe')
          : undefined,
        process.env['PROGRAMFILES(X86)']
          ? join(
              process.env['PROGRAMFILES(X86)'],
              'Mozilla Firefox',
              'firefox.exe',
            )
          : undefined,
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Firefox.app/Contents/MacOS/firefox']
      : ['/usr/bin/firefox', '/usr/local/bin/firefox'];

  for (const candidate of candidates) {
    if (candidate && await isAccessible(candidate)) return candidate;
  }
  return undefined;
}

async function assertFirefoxPackage() {
  const manifest = JSON.parse(
    await readFile(join(extensionRoot, 'manifest.json'), 'utf8'),
  );
  if (
    manifest.browser_specific_settings?.gecko?.id
      !== 'shinobu-translator@donutshinobu'
  ) {
    throw new Error('Firefox package is missing the expected Gecko identity.');
  }
  for (const path of [
    'background.js',
    'content.js',
    'popup.html',
    'chunks/extensionAdapter.js',
  ]) {
    if (!await isAccessible(join(extensionRoot, path))) {
      throw new Error(`Firefox package is missing ${path}.`);
    }
  }
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? 'twitter.com'}`,
    );
    if (requestUrl.pathname.startsWith('/media/')) {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'image/png',
      });
      response.end(onePixelPng);
      return;
    }

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
    });
    response.end(`<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Firefox packaged interaction fixture</title>
          <style>
            html, body { margin: 0; width: 100%; height: 100%; }
            #layers { width: 100%; height: 100%; }
            [role="dialog"] {
              align-items: center;
              display: flex;
              height: 100%;
              justify-content: center;
              position: relative;
              width: 100%;
            }
            img { height: 360px; image-rendering: pixelated; width: 520px; }
          </style>
        </head>
        <body>
          <div id="firefox-smoke-fixture" hidden>issue-47</div>
          <div id="layers">
            <div aria-labelledby="modal-header" role="dialog">
              <h1 id="modal-header" hidden>Media</h1>
              <article data-testid="tweet">
                <a href="/fixture/status/47">Ticket 47 fixture</a>
                <img
                  alt="fixture manga"
                  src="http://pbs.twimg.com/media/issue-47.png"
                >
              </article>
            </div>
          </div>
        </body>
      </html>`);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return server;
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

async function grantDeclaredHostAccess(driver, addonId) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    await driver.executeAsyncScript(`
      const addonId = arguments[0];
      const complete = arguments[arguments.length - 1];
      const { ExtensionPermissions } = ChromeUtils.importESModule(
        'resource://gre/modules/ExtensionPermissions.sys.mjs'
      );
      const policy = WebExtensionPolicy.getByID(addonId);
      if (!policy) {
        complete({ error: 'Installed Firefox extension policy was not found.' });
        return;
      }
      ExtensionPermissions.add(
        addonId,
        {
          data_collection: [],
          origins: ['<all_urls>'],
          permissions: [],
        },
        policy.extension,
      ).then(
        async () => {
          const contentUrl = policy.getURL('content.js');
          let parseError;
          try {
            await ChromeUtils.compileScript(contentUrl);
          } catch (error) {
            parseError = String(error);
          }
          complete({
            allowed: policy.canAccessURI(
              Services.io.newURI('http://twitter.com/fixture/status/47')
            ),
            contentUrl,
            parseError,
            ok: true,
          });
        },
        (error) => complete({ error: String(error) }),
      );
    `, addonId).then((result) => {
      if (!result?.ok) {
        throw new Error(
          `Could not grant declared Firefox host access: ${
            result?.error ?? 'unknown error'
          }`,
        );
      }
      if (!result.allowed) {
        throw new Error(
          'Firefox did not activate the declared twitter.com host access.',
        );
      }
      if (result.parseError) {
        throw new Error(
          `Firefox could not parse packaged content.js: ${result.parseError}`,
        );
      }
    });
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function run() {
  await assertFirefoxPackage();
  const server = await startFixtureServer();
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fixture server did not expose a TCP port.');
  }
  const firefoxBinary = await resolveFirefoxBinary();
  const options = new firefox.Options()
    .addArguments(
      '-headless',
      '--width=1280',
      '--height=900',
    )
    .enableBidi()
    .setPreference(
      'network.dns.localDomains',
      'twitter.com,pbs.twimg.com',
    )
    .setPreference('network.proxy.type', 1)
    .setPreference('network.proxy.http', '127.0.0.1')
    .setPreference('network.proxy.http_port', address.port)
    .setPreference('network.proxy.no_proxies_on', '')
    .setPreference('dom.security.https_only_mode', false)
    .setPreference('network.stricttransportsecurity.preloadlist', false)
    .setPreference('browser.shell.checkDefaultBrowser', false)
    .setPreference('remote.system-access-check.enabled', false)
    .setPreference('extensions.autoDisableScopes', 0);
  if (firefoxBinary) options.setBinary(firefoxBinary);
  const service = new firefox.ServiceBuilder()
    .addArguments('--allow-system-access');

  let driver;
  let logInspector;
  const bidiLogs = [];
  try {
    driver = await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .setFirefoxService(service)
      .build();
    logInspector = await LogInspector(driver);
    await logInspector.onLog((entry) => {
      bidiLogs.push(`${entry.level}: ${entry.text}`);
    });
    const addonId = await driver.installAddon(extensionRoot, true);
    if (addonId !== 'shinobu-translator@donutshinobu') {
      throw new Error(`Unexpected installed add-on id: ${addonId}`);
    }
    await grantDeclaredHostAccess(driver, addonId);

    await driver.get('http://twitter.com/fixture/status/47');
    await driver.wait(
      until.elementLocated(By.id('firefox-smoke-fixture')),
      5_000,
      'Firefox did not load the local packaged-interaction fixture.',
    );

    const inlineEntry = await driver.wait(
      until.elementLocated(By.css('.mt-x-overlay-inline')),
      15_000,
      'Firefox content entry did not mount the inline image control.',
    );
    await driver.wait(
      until.elementIsVisible(inlineEntry),
      5_000,
      'Firefox inline image control was mounted but not visible.',
    );
    const inlineButton = await inlineEntry.findElement(
      By.css('.mt-x-control:not(.mt-x-control-secondary)'),
    );
    await inlineButton.click();
    await driver.wait(
      async () => (
        await inlineButton.getAttribute('data-status')
      ) === 'error',
      20_000,
      'Firefox inline image entry did not reach the shared error UI.',
    );
    await driver.wait(
      async () => (
        await inlineButton.findElement(By.css('.mt-x-label')).getText()
      ) === '重试',
      5_000,
      'Firefox inline image entry did not expose the shared retry action.',
    );
    const inlineDetail = await inlineEntry.findElement(By.css('.mt-x-detail'));
    if (!(await inlineDetail.getText()).startsWith('翻译失败：')) {
      throw new Error(
        'Firefox inline image entry did not expose shared failure details.',
      );
    }

    const fixtureImage = await driver.findElement(
      By.css('img[alt="fixture manga"]'),
    );
    await driver.actions().contextClick(fixtureImage).perform();
    await driver.setContext(firefox.Context.CHROME);
    try {
      await driver.wait(async () => (
        await driver.executeScript(`
          return Array.from(document.querySelectorAll('menuitem'))
            .some((item) => item.label === '截图翻译');
        `)
      ), 5_000, 'Firefox native screenshot menu item was not registered.');
      await driver.executeScript(`
        const item = Array.from(document.querySelectorAll('menuitem'))
          .find((candidate) => candidate.label === '截图翻译');
        item.click();
      `);
    } finally {
      await driver.setContext(firefox.Context.CONTENT);
    }
    const screenshotEntry = await driver.wait(
      until.elementLocated(By.css('.mt-x-screenshot-select')),
      10_000,
      'Firefox native screenshot menu did not reach the content entry.',
    );
    await driver.wait(
      until.elementIsVisible(screenshotEntry),
      5_000,
      'Firefox screenshot selection entry was mounted but not visible.',
    );

    console.log(
      'Firefox packaged smoke passed: add-on install, inline image entry, '
        + 'shared retry UI, and native screenshot menu interaction.',
    );
  } catch (error) {
    if (driver) {
      const capabilities = await driver.getCapabilities();
      console.error(
        `Firefox ${capabilities.get('browserVersion') ?? 'unknown'} at `
          + `${await driver.getCurrentUrl()}`,
      );
      console.error(
        `Fixture marker count: ${await driver.findElements(
          By.id('firefox-smoke-fixture'),
        ).then((elements) => elements.length)}`,
      );
      try {
        const browserLogs = await driver.manage().logs().get('browser');
        for (const entry of browserLogs) {
          console.error(`Browser log: ${entry.message}`);
        }
      } catch {
        // Firefox may not expose browser logs through classic WebDriver.
      }
      for (const entry of bidiLogs) {
        console.error(`Firefox BiDi log: ${entry}`);
      }
      try {
        await driver.setContext(firefox.Context.CHROME);
        const consoleMessages = await driver.executeScript(`
          return Services.console.getMessageArray()
            .slice(-80)
            .map((entry) => ({
              line: entry.lineNumber,
              message: entry.message,
              source: entry.sourceName,
            }));
        `);
        for (const entry of consoleMessages) {
          console.error(
            `Firefox console: ${entry.message} `
              + `(${entry.source ?? 'unknown'}:${entry.line ?? 0})`,
          );
        }
        await driver.setContext(firefox.Context.CONTENT);
      } catch (consoleError) {
        console.error(
          `Firefox privileged console unavailable: ${
            consoleError instanceof Error
              ? consoleError.message
              : String(consoleError)
          }`,
        );
      }
    }
    throw error;
  } finally {
    if (logInspector) await logInspector.close();
    if (driver) await driver.quit();
    await closeServer(server);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
