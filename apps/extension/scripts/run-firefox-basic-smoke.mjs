#!/usr/bin/env node
import { createServer } from 'node:http';
import {
  access,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Builder,
  By,
  Key,
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
const imageHostOrigins = [
  'http://twitter.com/*',
  'http://x.com/*',
  'http://pbs.twimg.com/*',
];
const imageHostAccessUrls = [
  'http://twitter.com/fixture/status/47',
  'http://x.com/fixture/status/49-b',
  'http://pbs.twimg.com/media/issue-49-b.png',
];

function isHeaderLeaseRuleId(id) {
  return id >= 1_000_000 && id <= 1_999_999;
}

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
  const networkRequests = [];
  const mediaRequestCounts = new Map();
  let resolveLifecycleFetchStarted;
  let releaseLifecycleFetch;
  const lifecycleFetchStarted = new Promise((resolveStarted) => {
    resolveLifecycleFetchStarted = resolveStarted;
  });
  const lifecycleFetchReleased = new Promise((resolveReleased) => {
    releaseLifecycleFetch = resolveReleased;
  });
  const server = createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? 'twitter.com'}`,
    );
    if (requestUrl.pathname.startsWith('/media/')) {
      const requestCount = (mediaRequestCounts.get(requestUrl.pathname) ?? 0) + 1;
      mediaRequestCounts.set(requestUrl.pathname, requestCount);
      const expectedReferer = requestUrl.pathname === '/media/issue-49-b.png'
        ? 'http://x.com/'
        : 'http://twitter.com/';
      const isProtectedDownload = requestUrl.pathname.startsWith('/media/issue-49-')
        && requestCount > 1;
      const status = isProtectedDownload
        && (
          requestUrl.pathname === '/media/issue-49-rejected.png'
          || request.headers.referer !== expectedReferer
        )
        ? 403
        : 200;
      networkRequests.push({
        path: requestUrl.pathname,
        referer: request.headers.referer,
        status,
      });
      if (status === 403) {
        response.writeHead(403, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/html; charset=utf-8',
        });
        response.end('<html>hotlink rejected</html>');
        return;
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'image/png',
      });
      if (
        requestUrl.pathname === '/media/issue-51-stale.png'
        && requestCount > 1
      ) {
        resolveLifecycleFetchStarted?.();
        void lifecycleFetchReleased.then(() => response.end(onePixelPng));
        return;
      }
      const delay = requestUrl.pathname === '/media/issue-49-a.png'
        && requestCount > 1
        ? 250
        : 0;
      setTimeout(() => response.end(onePixelPng), delay);
      return;
    }

    const protectedFixtureMatch =
      /^\/fixture\/status\/(49-(?:a|b|rejected|revoked)|51-stale)$/u
      .exec(requestUrl.pathname);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      ...(protectedFixtureMatch ? { 'Referrer-Policy': 'origin' } : {}),
    });
    const fixtureId = protectedFixtureMatch?.[1] ?? '47';
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
          <div id="firefox-smoke-fixture" hidden>issue-${fixtureId}</div>
          <div id="layers">
            <div aria-labelledby="modal-header" role="dialog">
              <h1 id="modal-header" hidden>Media</h1>
              <article data-testid="tweet">
                <a href="/fixture/status/${fixtureId}">Ticket ${fixtureId} fixture</a>
                <img
                  alt="fixture manga"
                  src="http://pbs.twimg.com/media/issue-${fixtureId}.png"
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
  return {
    server,
    networkRequests,
    lifecycleFetchStarted,
    releaseLifecycleFetch() {
      releaseLifecycleFetch?.();
    },
  };
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
      const origins = arguments[1];
      const accessUrls = arguments[2];
      const complete = arguments[arguments.length - 1];
      const { ExtensionPermissions } = ChromeUtils.importESModule(
        'resource://gre/modules/ExtensionPermissions.sys.mjs'
      );
      const policy = WebExtensionPolicy.getByID(addonId);
      if (!policy) {
        complete({ error: 'Installed Firefox extension policy was not found.' });
        return;
      }
      ExtensionPermissions.remove(
        addonId,
        {
          data_collection: [],
          origins: ['<all_urls>'],
          permissions: [],
        },
        policy.extension,
      ).then(() => ExtensionPermissions.add(
        addonId,
        {
          data_collection: [],
          origins,
          permissions: [],
        },
        policy.extension,
      )).then(
        async () => {
          const contentUrl = policy.getURL('content.js');
          let parseError;
          try {
            await ChromeUtils.compileScript(contentUrl);
          } catch (error) {
            parseError = String(error);
          }
          complete({
            allowed: accessUrls.every(
              (url) => policy.canAccessURI(Services.io.newURI(url))
            ),
            contentUrl,
            parseError,
            ok: true,
          });
        },
        (error) => complete({ error: String(error) }),
      );
    `, addonId, imageHostOrigins, imageHostAccessUrls).then((result) => {
      if (!result?.ok) {
        throw new Error(
          `Could not grant declared Firefox host access: ${
            result?.error ?? 'unknown error'
          }`,
        );
      }
      if (!result.allowed) {
        throw new Error(
          'Firefox did not activate the declared image-download host access.',
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

async function updateCredentialPermissions(
  driver,
  addonId,
  operation,
  { authenticationInfo = false, cookies = false, origins = [] },
) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    const result = await driver.executeAsyncScript(`
      const addonId = arguments[0];
      const operation = arguments[1];
      const permissionDetails = arguments[2];
      const complete = arguments[arguments.length - 1];
      const { ExtensionPermissions } = ChromeUtils.importESModule(
        'resource://gre/modules/ExtensionPermissions.sys.mjs'
      );
      const policy = WebExtensionPolicy.getByID(addonId);
      if (!policy) {
        complete({ error: 'Installed Firefox extension policy was not found.' });
        return;
      }
      ExtensionPermissions[operation](
        addonId,
        permissionDetails,
        policy.extension,
      ).then(
        () => complete({ ok: true }),
        (error) => complete({ error: String(error) }),
      );
    `, addonId, operation, {
      data_collection: authenticationInfo ? ['authenticationInfo'] : [],
      origins,
      permissions: cookies ? ['cookies'] : [],
    });
    if (!result?.ok) {
      throw new Error(
        `Could not ${operation} Firefox credential permissions: ${
          result?.error ?? 'unknown error'
        }`,
      );
    }
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function revokeDeclaredHostAccess(driver, addonId) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    const result = await driver.executeAsyncScript(`
      const addonId = arguments[0];
      const origins = arguments[1];
      const accessUrls = arguments[2];
      const complete = arguments[arguments.length - 1];
      const { ExtensionPermissions } = ChromeUtils.importESModule(
        'resource://gre/modules/ExtensionPermissions.sys.mjs'
      );
      const policy = WebExtensionPolicy.getByID(addonId);
      if (!policy) {
        complete({ error: 'Installed Firefox extension policy was not found.' });
        return;
      }
      ExtensionPermissions.remove(
        addonId,
        {
          data_collection: [],
          origins,
          permissions: [],
        },
        policy.extension,
      ).then(
        () => complete({
          allowed: accessUrls.some(
            (url) => policy.canAccessURI(Services.io.newURI(url))
          ),
          ok: true,
        }),
        (error) => complete({ error: String(error) }),
      );
    `, addonId, imageHostOrigins, imageHostAccessUrls);
    if (!result?.ok || result.allowed) {
      throw new Error(
        `Could not revoke declared Firefox host access: ${
          result?.error ?? JSON.stringify(result)
        }`,
      );
    }
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function configurePipelineEvidence(driver, addonId) {
  await driver.setContext(firefox.Context.CHROME);
  let popupUrl;
  try {
    popupUrl = await driver.executeScript(`
      const policy = WebExtensionPolicy.getByID(arguments[0]);
      return policy?.getURL('popup.html');
    `, addonId);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
  if (typeof popupUrl !== 'string' || popupUrl.length === 0) {
    throw new Error('Installed Firefox extension popup URL was not found.');
  }
  await driver.get(popupUrl);
  await driver.executeAsyncScript(`
    const complete = arguments[arguments.length - 1];
    browser.storage.local.get('mangaTranslate.settings').then((saved) => {
      const settings = saved['mangaTranslate.settings'] || {};
      return browser.storage.local.set({
        'mangaTranslate.settings': {
          ...settings,
          showElapsedTime: true,
          showStageTimingDetails: true,
          stageTimingCardExpanded: true,
        },
      });
    }).then(
      () => complete({ ok: true }),
      (error) => complete({ error: String(error) }),
    );
  `).then((result) => {
    if (!result?.ok) {
      throw new Error(
        `Could not configure Firefox pipeline evidence: ${
          result?.error ?? 'unknown error'
        }`,
      );
    }
  });
  return popupUrl;
}

async function respondToPermissionPrompt(driver, response, label) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    let prompt;
    try {
      prompt = await driver.wait(
        async () => driver.executeScript(`
          const panel = document.querySelector('#notification-popup');
          if (panel?.state !== 'open') return null;
          const primary = panel.querySelector(
            '.popup-notification-primary-button'
          );
          const secondary = panel.querySelector(
            '.popup-notification-secondary-button'
          );
          return primary && secondary
            ? {
                primary: primary.getAttribute('label'),
                secondary: secondary.getAttribute('label'),
                text: panel.textContent,
              }
            : null;
        `),
        10_000,
        `Firefox did not show the expected ${label} permission prompt.`,
      );
    } catch (error) {
      await driver.setContext(firefox.Context.CONTENT);
      const bodyText = await driver.findElement(By.css('body')).getText();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} `
          + `Popup text: ${bodyText}`,
      );
    }
    await driver.executeScript(`
      document.querySelector('#notification-popup').querySelector(
        arguments[0] === 'accept'
          ? '.popup-notification-primary-button'
          : '.popup-notification-secondary-button'
      ).click();
    `, response);
    return prompt;
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function readHeaderOverrideRuleIds(driver, addonId) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    const result = await driver.executeScript(`
      const addonId = arguments[0];
      const { ExtensionDNR } = ChromeUtils.importESModule(
        'resource://gre/modules/ExtensionDNR.sys.mjs'
      );
      const policy = WebExtensionPolicy.getByID(addonId);
      const manager = policy
        ? ExtensionDNR.getRuleManager(policy.extension, false)
        : undefined;
      return {
        dynamic: manager?.getDynamicRules().map((rule) => rule.id) ?? [],
        session: manager?.getSessionRules().map((rule) => rule.id) ?? [],
      };
    `, addonId);
    return result;
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function containsExtensionPermissions(driver, details) {
  const result = await driver.executeAsyncScript(`
    const details = arguments[0];
    const complete = arguments[arguments.length - 1];
    browser.permissions.contains(details).then(
      (granted) => complete({ ok: true, granted }),
      (error) => complete({ error: String(error) }),
    );
  `, details);
  if (!result?.ok) {
    throw new Error(
      `Could not inspect Firefox extension permissions: ${
        result?.error ?? 'unknown error'
      }`,
    );
  }
  return result.granted;
}

async function resolveExtensionUrl(driver, addonId, path) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeScript(`
      const policy = WebExtensionPolicy.getByID(arguments[0]);
      return policy?.getURL(arguments[1]);
    `, addonId, path);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function sendExtensionMessage(driver, message) {
  const result = await driver.executeAsyncScript(`
    const message = arguments[0];
    const complete = arguments[arguments.length - 1];
    browser.runtime.sendMessage(message).then(
      (value) => complete({ ok: true, value }),
      (error) => complete({ error: String(error) }),
    );
  `, message);
  if (!result?.ok) {
    throw new Error(
      `Packaged Firefox runtime request failed: ${
        result?.error ?? 'unknown error'
      }`,
    );
  }
  return result.value;
}

async function readBackgroundSnapshot(driver, addonId) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    return await driver.executeScript(`
      const extension = WebExtensionPolicy.getByID(arguments[0])?.extension;
      return {
        contextId: extension?.backgroundContext?.contextId ?? null,
        state: extension?.backgroundState ?? 'missing',
      };
    `, addonId);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function terminateBackground(driver, addonId, label) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    const result = await driver.executeAsyncScript(`
      const extension = WebExtensionPolicy.getByID(arguments[0])?.extension;
      const complete = arguments[arguments.length - 1];
      if (!extension || typeof extension.terminateBackground !== 'function') {
        complete({ error: 'Firefox Event Page termination is unavailable.' });
        return;
      }
      const beforeContextId = extension.backgroundContext?.contextId ?? null;
      extension.terminateBackground({
        disableResetIdleForTest: true,
      }).then(
        () => complete({
          beforeContextId,
          contextId: extension.backgroundContext?.contextId ?? null,
          state: extension.backgroundState,
        }),
        (error) => complete({ error: String(error) }),
      );
    `, addonId);
    if (
      result?.error
      || result?.beforeContextId === null
      || result?.state !== 'stopped'
      || result?.contextId !== null
    ) {
      throw new Error(
        `${label} did not terminate the Firefox Event Page: ${
          JSON.stringify(result)
        }`,
      );
    }
    return result.beforeContextId;
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

async function waitForBackgroundRebuild(
  driver,
  addonId,
  previousContextId,
  label,
) {
  const rebuilt = await driver.wait(
    async () => {
      const snapshot = await readBackgroundSnapshot(driver, addonId);
      return snapshot.state === 'running'
        && snapshot.contextId !== null
        && snapshot.contextId !== previousContextId
        ? snapshot
        : false;
    },
    15_000,
    `${label} did not rebuild the Firefox Event Page.`,
  );
  return rebuilt.contextId;
}

async function waitForIdleUnload(driver, addonId, activeContextId) {
  await driver.wait(
    async () => {
      const snapshot = await readBackgroundSnapshot(driver, addonId);
      return snapshot.state === 'stopped'
        && snapshot.contextId === null;
    },
    75_000,
    `Firefox Event Page ${activeContextId} did not unload while idle.`,
  );
}

async function readExtensionStorage(driver, area, keys) {
  const result = await driver.executeAsyncScript(`
    const area = arguments[0];
    const keys = arguments[1];
    const complete = arguments[arguments.length - 1];
    browser.storage[area].get(keys).then(
      (value) => complete({ ok: true, value }),
      (error) => complete({ error: String(error) }),
    );
  `, area, keys);
  if (!result?.ok) {
    throw new Error(
      `Could not read Firefox ${area} storage: ${
        result?.error ?? 'unknown error'
      }`,
    );
  }
  return result.value;
}

async function writeExtensionStorage(driver, area, value) {
  const result = await driver.executeAsyncScript(`
    const area = arguments[0];
    const value = arguments[1];
    const complete = arguments[arguments.length - 1];
    browser.storage[area].set(value).then(
      () => complete({ ok: true }),
      (error) => complete({ error: String(error) }),
    );
  `, area, value);
  if (!result?.ok) {
    throw new Error(
      `Could not write Firefox ${area} storage: ${
        result?.error ?? 'unknown error'
      }`,
    );
  }
}

async function startInterruptiblePipelineProbe(driver) {
  await driver.executeScript(`
    const inputBase64 = arguments[0];
    const inputBytes = arguments[1];
    const jobId = 'firefox-interrupted-' + crypto.randomUUID();
    const port = browser.runtime.connect({ name: 'mt:local-pipeline-client' });
    const state = {
      disconnects: 0,
      jobId,
      messages: [],
      terminalMessages: [],
    };
    window.__shinobuInterruptedPipeline = state;
    port.onDisconnect.addListener(() => {
      state.disconnects += 1;
      state.disconnectError = browser.runtime.lastError?.message;
    });
    port.onMessage.addListener((message) => {
      if (message.jobId && message.jobId !== jobId) return;
      state.messages.push(message.type);
      if (message.type === 'ready') {
        port.postMessage({
          type: 'start',
          jobId,
          file: {
            name: 'firefox-interrupted.png',
            type: 'image/png',
            size: inputBytes,
            lastModified: Date.now(),
          },
          config: {
            sourceLang: 'ja',
            targetLang: 'zh-CHS',
            translator: 'google_web',
            llmProvider: 'deepseek',
            llmAuthMode: 'api_key',
            llmBaseUrl: 'https://api.deepseek.com/v1',
            llmApiKey: '',
            llmModel: 'deepseek-chat',
            typesetDebug: false,
            eraseDebug: false,
            collectDebugLog: false,
            ocrEngine: 'paddleocr_v6_medium',
            processMode: 'translate',
          },
          input: {
            chunkCount: 1,
            totalChars: inputBase64.length,
          },
        });
        port.postMessage({
          type: 'input-chunk',
          jobId,
          index: 0,
          data: inputBase64,
        });
        port.postMessage({ type: 'input-complete', jobId });
        return;
      }
      if (message.type === 'complete' || message.type === 'error') {
        state.terminalMessages.push(message.type);
      }
    });
    port.postMessage({ type: 'prepare', jobId });
  `, onePixelPng.toString('base64'), onePixelPng.length);
  await driver.wait(
    async () => driver.executeScript(`
      return window.__shinobuInterruptedPipeline?.messages
        .includes('queued');
    `),
    30_000,
    'Firefox interrupted pipeline did not reach active admission.',
  );
}

async function readInterruptedPipelineProbe(driver) {
  return await driver.executeScript(`
    const state = window.__shinobuInterruptedPipeline;
    return state ? {
      disconnects: state.disconnects,
      disconnectError: state.disconnectError,
      jobId: state.jobId,
      messages: [...state.messages],
      terminalMessages: [...state.terminalMessages],
    } : null;
  `);
}

function assertPermissionRequired(response, expectedMissing, label) {
  const actualMissing = response?.permission?.missing?.map(
    (requirement) => requirement.kind,
  );
  if (
    response?.ok !== false
    || response.permission?.status !== 'permission-required'
    || JSON.stringify(actualMissing) !== JSON.stringify(expectedMissing)
  ) {
    throw new Error(
      `${label} did not fail closed with ${expectedMissing.join(', ')}: ${
        JSON.stringify(response)
      }`,
    );
  }
}

async function selectPopupProvider(driver, label, keyboard = false) {
  const trigger = await driver.findElement(
    By.css('button[aria-label="LLM 提供商"]'),
  );
  await trigger.click();
  if (keyboard) {
    await trigger.sendKeys([...label][0]);
    await driver.wait(
      async () => {
        const activeId = await trigger.getAttribute('aria-activedescendant');
        if (!activeId) return false;
        const active = await driver.findElement(By.id(activeId));
        return (await active.getText()) === label;
      },
      5_000,
      `Firefox popup did not focus provider ${label}.`,
    );
    await trigger.sendKeys(Key.ENTER);
    return;
  }
  const option = await driver.wait(
    until.elementLocated(By.xpath(
      `//button[contains(@class, "select-option")][normalize-space(.)="${label}"]`,
    )),
    5_000,
    `Firefox popup did not expose provider ${label}.`,
  );
  await driver.executeScript(
    'arguments[0].scrollIntoView({ block: "nearest" });',
    option,
  );
  await driver.actions().move({ origin: option }).click().perform();
}

async function runAuthenticationSmoke(driver, addonId) {
  await updateCredentialPermissions(driver, addonId, 'remove', {
    authenticationInfo: true,
    cookies: true,
  });
  const popupUrl = await resolveExtensionUrl(driver, addonId, 'popup.html');
  if (typeof popupUrl !== 'string') {
    throw new Error('Firefox extension policy did not expose popup.html.');
  }
  await driver.get(popupUrl);
  await driver.wait(
    until.elementLocated(By.css('.popup')),
    10_000,
    'Firefox packaged popup did not mount.',
  );

  const llmMode = await driver.wait(
    until.elementLocated(By.xpath('//button[normalize-space(.)="大模型"]')),
    10_000,
    'Firefox popup did not finish loading translation settings.',
  );
  if (await containsExtensionPermissions(driver, {
    data_collection: ['authenticationInfo'],
  })) {
    throw new Error('Firefox retained authenticationInfo before the UI test.');
  }
  await llmMode.click();
  const deniedApiKeyPrompt = await respondToPermissionPrompt(
    driver,
    'dismiss',
    'API Key denial',
  );
  if (!deniedApiKeyPrompt.text.includes('authentication information')) {
    throw new Error(
      `API Key prompt omitted authentication information: ${
        JSON.stringify(deniedApiKeyPrompt)
      }`,
    );
  }
  await driver.wait(
    async () => (await driver.findElement(By.css('body')).getText())
      .includes('需要授权：认证数据'),
    5_000,
    'Denied API Key permission did not reach the popup error state.',
  );
  if ((await driver.findElements(By.css('.panel-llm'))).length !== 0) {
    throw new Error('Denied API Key permission enabled the LLM settings panel.');
  }
  if (await containsExtensionPermissions(driver, {
    data_collection: ['authenticationInfo'],
  })) {
    throw new Error('Denied API Key permission was unexpectedly retained.');
  }
  await llmMode.click();
  const grantedApiKeyPrompt = await respondToPermissionPrompt(
    driver,
    'accept',
    'API Key grant',
  );
  if (!grantedApiKeyPrompt.text.includes('authentication information')) {
    throw new Error(
      `API Key grant prompt omitted authentication information: ${
        JSON.stringify(grantedApiKeyPrompt)
      }`,
    );
  }
  const providerTrigger = await driver.wait(
    until.elementLocated(By.css('button[aria-label="LLM 提供商"]')),
    5_000,
    'Firefox popup did not enable LLM provider selection.',
  );
  if (!await containsExtensionPermissions(driver, {
    data_collection: ['authenticationInfo'],
  })) {
    throw new Error('Firefox UI grant did not retain authenticationInfo.');
  }
  if (await containsExtensionPermissions(driver, {
    permissions: ['cookies'],
  })) {
    throw new Error(
      'Firefox granted cookies before the Gemini user-gesture test.',
    );
  }
  const selectedProvider = await providerTrigger.getText();
  await providerTrigger.click();
  const providerOptions = await driver.findElements(By.css('.select-option'));
  const providerLabels = new Set([
    selectedProvider,
    ...await Promise.all(providerOptions.map((element) => element.getText())),
  ]);
  for (const label of [
    'DeepSeek',
    'Nano Banana',
    'GLM (智谱)',
    'Kimi (月之暗面)',
    'MiniMax',
    'MiMo (小米)',
    'OpenAI',
    '自定义提供商',
  ]) {
    if (!providerLabels.has(label)) {
      throw new Error(`Firefox popup is missing provider ${label}.`);
    }
  }
  await providerTrigger.click();

  await updateCredentialPermissions(driver, addonId, 'remove', {
    authenticationInfo: true,
  });
  await selectPopupProvider(driver, 'Nano Banana');
  const deniedGeminiPrompt = await respondToPermissionPrompt(
    driver,
    'dismiss',
    'Gemini denial',
  );
  if (!deniedGeminiPrompt.text.includes('authentication information')) {
    throw new Error(
      `Gemini prompt omitted authentication information: ${
        JSON.stringify(deniedGeminiPrompt)
      }`,
    );
  }
  await driver.wait(
    async () => (await driver.findElement(By.css('body')).getText())
      .includes('需要授权：认证数据'),
    5_000,
    'Denied Gemini permission did not reach the popup error state.',
  );
  if ((await providerTrigger.getText()) !== selectedProvider) {
    throw new Error('Denied Gemini permission changed the active provider.');
  }
  if (!await containsExtensionPermissions(driver, {
    permissions: ['cookies'],
  })) {
    throw new Error(
      'Gemini user gesture did not request the silently granted Cookie permission.',
    );
  }
  await selectPopupProvider(driver, 'Nano Banana');
  const grantedGeminiPrompt = await respondToPermissionPrompt(
    driver,
    'accept',
    'Gemini grant',
  );
  if (!grantedGeminiPrompt.text.includes('authentication information')) {
    throw new Error(
      `Gemini grant prompt omitted authentication information: ${
        JSON.stringify(grantedGeminiPrompt)
      }`,
    );
  }
  await driver.wait(
    async () => (await providerTrigger.getText()) === 'Nano Banana',
    5_000,
    'Granted Gemini permission did not change the active provider.',
  );
  if (!await containsExtensionPermissions(driver, {
    data_collection: ['authenticationInfo'],
    permissions: ['cookies'],
  })) {
    throw new Error(
      'Gemini UI grant did not retain authenticationInfo and cookies.',
    );
  }
  for (const mode of ['Gemini 登录', 'API Key']) {
    await driver.wait(
      until.elementLocated(By.xpath(`//button[normalize-space(.)="${mode}"]`)),
      5_000,
      `Firefox popup is missing Gemini mode ${mode}.`,
    );
  }

  await selectPopupProvider(driver, 'OpenAI');
  for (const mode of ['OpenAI 登录', 'API Key']) {
    await driver.wait(
      until.elementLocated(By.xpath(`//button[normalize-space(.)="${mode}"]`)),
      5_000,
      `Firefox popup is missing OpenAI mode ${mode}.`,
    );
  }
  const popupHandle = await driver.getWindowHandle();
  const handlesBeforeOpenAiLogin = await driver.getAllWindowHandles();
  await updateCredentialPermissions(driver, addonId, 'remove', {
    authenticationInfo: true,
  });
  const openAiLogin = await driver.findElement(
    By.xpath('//button[normalize-space(.)="登录 OpenAI"]'),
  );
  await openAiLogin.click();
  const deniedOpenAiPrompt = await respondToPermissionPrompt(
    driver,
    'dismiss',
    'OpenAI denial',
  );
  if (!deniedOpenAiPrompt.text.includes('authentication information')) {
    throw new Error(
      `OpenAI prompt omitted authentication information: ${
        JSON.stringify(deniedOpenAiPrompt)
      }`,
    );
  }
  await driver.wait(
    async () => (await driver.findElement(By.css('body')).getText())
      .includes('需要授权：认证数据'),
    5_000,
    'Denied OpenAI permission did not reach the popup error state.',
  );
  if (
    (await driver.getAllWindowHandles()).length
      !== handlesBeforeOpenAiLogin.length
  ) {
    throw new Error('Denied OpenAI permission still opened a login tab.');
  }
  await openAiLogin.click();
  await respondToPermissionPrompt(driver, 'accept', 'OpenAI grant');
  await driver.wait(
    async () => (await driver.getAllWindowHandles()).length
      > handlesBeforeOpenAiLogin.length,
    10_000,
    'Granted OpenAI permission did not open the login tab.',
  );
  for (const handle of await driver.getAllWindowHandles()) {
    if (handle === popupHandle) continue;
    await driver.switchTo().window(handle);
    await driver.close();
  }
  await driver.switchTo().window(popupHandle);

  await selectPopupProvider(driver, '自定义提供商', true);
  const customBaseUrl = await driver.wait(
    until.elementLocated(By.css(
      'input[placeholder="https://api.example.com/v1"]',
    )),
    5_000,
    'Firefox popup is missing the custom Base URL field.',
  );
  await customBaseUrl.sendKeys('https://llm.example.test/v1');
  const authorizeEndpoint = await driver.wait(
    until.elementLocated(By.xpath(
      '//button[normalize-space(.)="授权 Endpoint"]',
    )),
    5_000,
    'Firefox popup is missing custom endpoint authorization.',
  );
  if (await containsExtensionPermissions(driver, {
    origins: ['https://llm.example.test/*'],
  })) {
    throw new Error('Custom endpoint origin was granted before its UI action.');
  }
  await authorizeEndpoint.click();
  const deniedEndpointPrompt = await respondToPermissionPrompt(
    driver,
    'dismiss',
    'custom endpoint denial',
  );
  if (!deniedEndpointPrompt.text.includes('llm.example.test')) {
    throw new Error(
      `Custom endpoint prompt omitted its normalized host: ${
        JSON.stringify(deniedEndpointPrompt)
      }`,
    );
  }
  await driver.wait(
    async () => (await driver.findElement(By.css('body')).getText())
      .includes('需要授权：https://llm.example.test'),
    5_000,
    'Denied custom endpoint permission did not reach the popup error state.',
  );
  if (await containsExtensionPermissions(driver, {
    origins: ['https://llm.example.test/*'],
  })) {
    throw new Error('Denied custom endpoint origin was unexpectedly retained.');
  }
  await authorizeEndpoint.click();
  await respondToPermissionPrompt(driver, 'accept', 'custom endpoint grant');
  if (!await containsExtensionPermissions(driver, {
    origins: ['https://llm.example.test/*'],
  })) {
    throw new Error(
      'Custom endpoint UI did not retain the normalized Firefox origin.',
    );
  }
  await driver.wait(
    async () => (await driver.findElement(By.css('.status-success')).getText())
      === '已授权 https://llm.example.test',
    5_000,
    'Custom endpoint authorization did not report the normalized origin.',
  );
  await updateCredentialPermissions(driver, addonId, 'remove', {
    origins: ['https://llm.example.test/*'],
  });
  assertPermissionRequired(
    await sendExtensionMessage(driver, {
      type: 'mt:llm-chat-completions',
      body: {
        model: 'firefox-auth-smoke',
        messages: [{ role: 'user', content: 'translate' }],
      },
      proxyConfig: {
        provider: 'custom',
        authMode: 'api_key',
        baseUrl: 'https://llm.example.test/v1',
      },
    }),
    ['target-origin'],
    'Custom endpoint origin revocation',
  );
  await authorizeEndpoint.click();
  await respondToPermissionPrompt(
    driver,
    'accept',
    'custom endpoint reauthorization',
  );
  if (!await containsExtensionPermissions(driver, {
    origins: ['https://llm.example.test/*'],
  })) {
    throw new Error('Custom endpoint UI did not reauthorize its origin.');
  }

  await updateCredentialPermissions(driver, addonId, 'remove', {
    cookies: true,
  });
  const geminiRevoked = await sendExtensionMessage(driver, {
    type: 'mt:gemini-app-auth-status',
  });
  assertPermissionRequired(
    geminiRevoked,
    ['cookie-access'],
    'Gemini Cookie revocation',
  );
  const openAiStillAvailable = await sendExtensionMessage(driver, {
    type: 'mt:openai-oauth-status',
  });
  if (
    openAiStillAvailable?.ok !== true
    || openAiStillAvailable.type !== 'mt:openai-oauth-status'
  ) {
    throw new Error(
      `Cookie revocation incorrectly disabled OpenAI OAuth: ${
        JSON.stringify(openAiStillAvailable)
      }`,
    );
  }

  await updateCredentialPermissions(driver, addonId, 'remove', {
    authenticationInfo: true,
  });
  const providerCases = [
    ['deepseek', 'https://api.deepseek.com'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1'],
    ['glm', 'https://api.z.ai/api/paas/v4'],
    ['kimi', 'https://api.moonshot.ai/v1'],
    ['minimax', 'https://api.minimax.io/v1'],
    ['mimo', 'https://api.xiaomimimo.com/v1'],
    ['openai', 'https://api.openai.com/v1'],
    ['custom', 'https://llm.example.test/v1'],
  ];
  for (const [provider, baseUrl] of providerCases) {
    const response = await sendExtensionMessage(driver, {
      type: 'mt:llm-chat-completions',
      body: {
        model: 'firefox-auth-smoke',
        messages: [{ role: 'user', content: 'translate' }],
      },
      proxyConfig: {
        provider,
        authMode: 'api_key',
        baseUrl,
      },
    });
    assertPermissionRequired(
      response,
      ['authentication-data-use'],
      `${provider} API Key revocation`,
    );
  }
  assertPermissionRequired(
    await sendExtensionMessage(driver, {
      type: 'mt:openai-oauth-status',
    }),
    ['authentication-data-use'],
    'OpenAI OAuth revocation',
  );

  const googleWeb = await driver.findElement(
    By.xpath('//button[normalize-space(.)="谷歌翻译"]'),
  );
  await googleWeb.click();
  for (const mode of ['原文', '去字']) {
    const button = await driver.findElement(
      By.xpath(`//button[normalize-space(.)="${mode}"]`),
    );
    if (!await button.isEnabled()) {
      throw new Error(
        `Credential revocation incorrectly disabled ${mode} mode.`,
      );
    }
  }

  await updateCredentialPermissions(driver, addonId, 'add', {
    authenticationInfo: true,
    cookies: true,
  });
}

async function openInlineFixture(driver, path, hostname = 'twitter.com') {
  await driver.switchTo().newWindow('tab');
  await driver.get(`http://${hostname}${path}`);
  await driver.wait(
    until.elementLocated(By.id('firefox-smoke-fixture')),
    5_000,
    `Firefox did not load network fixture ${path}.`,
  );
  const inlineEntry = await driver.wait(
    until.elementLocated(By.css('.mt-x-overlay-inline')),
    15_000,
    `Firefox content entry did not mount for ${path}.`,
  );
  await driver.wait(
    until.elementIsVisible(inlineEntry),
    5_000,
    `Firefox content entry was not visible for ${path}.`,
  );
  return await driver.getWindowHandle();
}

async function clickInlineFixture(driver, handle) {
  await driver.switchTo().window(handle);
  const inlineButton = await driver.findElement(
    By.css('.mt-x-overlay-inline .mt-x-control:not(.mt-x-control-secondary)'),
  );
  await inlineButton.click();
}

async function waitForInlineResult(
  driver,
  handle,
  label,
  expectedStatus,
  expectedDetail,
  timeoutMs = 30_000,
) {
  await driver.switchTo().window(handle);
  const inlineButton = await driver.findElement(
    By.css('.mt-x-overlay-inline .mt-x-control:not(.mt-x-control-secondary)'),
  );
  const terminalStatuses = expectedStatus
    ? [expectedStatus]
    : ['error', 'translated'];
  await driver.wait(
    async () => terminalStatuses.includes(
      await inlineButton.getAttribute('data-status'),
    ),
    timeoutMs,
    `${label} did not reach ${terminalStatuses.join(' or ')}.`,
  );
  const detail = await driver.findElement(
    By.css('.mt-x-overlay-inline .mt-x-detail'),
  ).getText();
  if (expectedDetail && !detail.includes(expectedDetail)) {
    throw new Error(
      `${label} did not expose ${expectedDetail}: ${detail}`,
    );
  }
  return detail;
}

async function runDirectPipelineProbe(driver, popupUrl) {
  const windowCountBefore = (await driver.getAllWindowHandles()).length;
  await driver.get(popupUrl);
  await driver.manage().setTimeouts({ script: 180_000 });
  const report = await driver.executeAsyncScript(`
    const inputBase64 = arguments[0];
    const inputBytes = arguments[1];
    const complete = arguments[arguments.length - 1];
    const jobId = 'firefox-smoke-' + crypto.randomUUID();
    const port = browser.runtime.connect({ name: 'mt:local-pipeline-client' });
    const progress = [];
    const resultChunks = new Map();
    let resultMeta;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      port.disconnect();
      complete(value);
    };
    const deadline = setTimeout(() => {
      finish({ error: 'Firefox direct pipeline probe timed out.', progress });
    }, 170_000);
    const heartbeat = setInterval(() => {
      port.postMessage({ type: 'heartbeat', jobId });
    }, 1_000);

    port.onDisconnect.addListener(() => {
      if (!settled) {
        finish({
          error: browser.runtime.lastError?.message
            || 'Firefox direct pipeline Port disconnected.',
          progress,
        });
      }
    });
    port.onMessage.addListener((message) => {
      if (message.jobId && message.jobId !== jobId) return;
      if (message.type === 'ready') {
        port.postMessage({
          type: 'start',
          jobId,
          file: {
            name: 'firefox-smoke.png',
            type: 'image/png',
            size: inputBytes,
            lastModified: Date.now(),
          },
          config: {
            sourceLang: 'ja',
            targetLang: 'zh-CHS',
            translator: 'google_web',
            llmProvider: 'deepseek',
            llmAuthMode: 'api_key',
            llmBaseUrl: 'https://api.deepseek.com/v1',
            llmApiKey: '',
            llmModel: 'deepseek-chat',
            typesetDebug: false,
            eraseDebug: false,
            collectDebugLog: false,
            ocrEngine: 'paddleocr_v6_medium',
            processMode: 'translate',
          },
          input: {
            chunkCount: 1,
            totalChars: inputBase64.length,
          },
        });
        port.postMessage({
          type: 'input-chunk',
          jobId,
          index: 0,
          data: inputBase64,
        });
        port.postMessage({ type: 'input-complete', jobId });
        return;
      }
      if (message.type === 'queued') {
        progress.push('queued');
        return;
      }
      if (message.type === 'progress') {
        progress.push(message.progress?.stage || 'unknown');
        return;
      }
      if (message.type === 'result-meta') {
        resultMeta = message;
        return;
      }
      if (message.type === 'result-chunk' && message.artifact === 'result') {
        resultChunks.set(message.index, message.data);
        return;
      }
      if (message.type === 'error') {
        finish({ error: message.error, progress });
        return;
      }
      if (message.type === 'complete') {
        finish({
          ok: true,
          progress,
          resultMeta,
          resultChunkCount: resultChunks.size,
          resultTotalChars: [...resultChunks.values()]
            .reduce((total, chunk) => total + chunk.length, 0),
        });
      }
    });
    port.postMessage({ type: 'prepare', jobId });
  `, onePixelPng.toString('base64'), onePixelPng.length);

  if (!report?.ok) {
    throw new Error(
      `Firefox direct Event Page pipeline failed: ${
        JSON.stringify(report?.error ?? report)
      }`,
    );
  }
  if (
    !report.progress?.includes('runtime-prepare')
    || !report.progress?.includes('detect')
    || !report.progress?.includes('done')
  ) {
    throw new Error(
      `Firefox direct Event Page pipeline progress was incomplete: ${
        JSON.stringify(report.progress)
      }`,
    );
  }
  if (
    !['completed', 'no-translatable-text'].includes(report.resultMeta?.status)
    || !report.resultMeta?.summary
    || !report.resultMeta?.record
    || !Array.isArray(report.resultMeta?.providerReports)
  ) {
    throw new Error(
      `Firefox direct Event Page result contract was incomplete: ${
        JSON.stringify(report.resultMeta)
      }`,
    );
  }
  if (
    report.resultChunkCount !== report.resultMeta.result.chunkCount
    || report.resultTotalChars !== report.resultMeta.result.totalChars
  ) {
    throw new Error(
      'Firefox direct Event Page result image chunks did not match metadata.',
    );
  }
  const expectedProvider = process.env.FIREFOX_EXPECTED_PROVIDER;
  const providerEvidence = JSON.stringify({
    providerReports: report.resultMeta.providerReports,
    runtimeStages: report.resultMeta.summary.runtimeStages,
  });
  if (expectedProvider && !providerEvidence.includes(expectedProvider)) {
    throw new Error(
      `Firefox direct Event Page pipeline did not use expected ${
        expectedProvider
      } provider: ${providerEvidence}`,
    );
  }
  if ((await driver.getAllWindowHandles()).length !== windowCountBefore) {
    throw new Error(
      'Firefox direct Event Page pipeline created a dedicated host page.',
    );
  }
  return providerEvidence;
}

function withDeadline(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rejectDeadline) => {
      timer = setTimeout(
        () => rejectDeadline(new Error(`${label} timed out.`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runOAuthRebuildSmoke(driver, addonId, popupUrl) {
  await driver.switchTo().newWindow('tab');
  await driver.get(popupUrl);
  await updateCredentialPermissions(driver, addonId, 'add', {
    authenticationInfo: true,
  });
  const popupHandle = await driver.getWindowHandle();
  const handlesBeforeLogin = await driver.getAllWindowHandles();
  const login = await sendExtensionMessage(driver, {
    type: 'mt:openai-oauth-login',
  });
  if (
    login?.ok !== true
    || login.type !== 'mt:openai-oauth-login'
    || login.status?.pending !== true
  ) {
    throw new Error(
      `Firefox OAuth lifecycle login did not persist pending PKCE state: ${
        JSON.stringify(login)
      }`,
    );
  }
  const authHandle = await driver.wait(
    async () => {
      const handles = await driver.getAllWindowHandles();
      return handles.find((handle) => !handlesBeforeLogin.includes(handle))
        ?? false;
    },
    10_000,
    'Firefox OAuth lifecycle login did not open an authentication tab.',
  );
  await driver.switchTo().window(popupHandle);
  const pendingBefore = await readExtensionStorage(driver, 'local', [
    'mangaTranslate.openaiOAuthPending',
  ]);
  const pending = pendingBefore['mangaTranslate.openaiOAuthPending'];
  if (
    typeof pending?.state !== 'string'
    || typeof pending.codeVerifier !== 'string'
    || pending.redirectUri !== 'http://localhost:1457/auth/callback'
    || typeof pending.tabId !== 'number'
  ) {
    throw new Error(
      `Firefox OAuth pending state was incomplete before rebuild: ${
        JSON.stringify(pending)
      }`,
    );
  }

  const previousContextId = await terminateBackground(
    driver,
    addonId,
    'OAuth callback rebuild',
  );
  const callbackUrl = `${pending.redirectUri}?error=access_denied`
      + '&error_description=issue-51-lifecycle'
      + `&state=${encodeURIComponent(pending.state)}`;
  const callbackNavigation = await driver.executeAsyncScript(`
    const tabId = arguments[0];
    const callbackUrl = arguments[1];
    const complete = arguments[arguments.length - 1];
    browser.tabs.update(tabId, { url: callbackUrl }).then(
      () => complete({ ok: true }),
      (error) => complete({ error: String(error) }),
    );
  `, pending.tabId, callbackUrl);
  if (!callbackNavigation?.ok) {
    throw new Error(
      `Firefox OAuth callback tab could not navigate after rebuild: ${
        callbackNavigation?.error ?? 'unknown error'
      }`,
    );
  }
  await driver.wait(
    async () => !(await driver.getAllWindowHandles()).includes(authHandle),
    10_000,
    'Firefox OAuth callback did not close its authentication tab.',
  );
  await driver.switchTo().window(popupHandle);
  await waitForBackgroundRebuild(
    driver,
    addonId,
    previousContextId,
    'OAuth callback listener',
  );
  const callbackState = await readExtensionStorage(driver, 'local', [
    'mangaTranslate.openaiOAuthPending',
    'mangaTranslate.openaiOAuthLastError',
  ]);
  if (
    callbackState['mangaTranslate.openaiOAuthPending'] !== undefined
    || !String(
      callbackState['mangaTranslate.openaiOAuthLastError'] ?? '',
    ).includes('issue-51-lifecycle')
  ) {
    throw new Error(
      `Firefox OAuth callback did not resume persisted pending state: ${
        JSON.stringify(callbackState)
      }`,
    );
  }

  const now = Date.now();
  await writeExtensionStorage(driver, 'local', {
    'mangaTranslate.openaiOAuth': {
      idToken: 'issue-51-id-token',
      accessToken: 'issue-51-access-token',
      refreshToken: 'issue-51-refresh-token',
      accountId: 'issue-51-account',
      email: 'lifecycle@example.invalid',
      planType: 'test',
      expiresAt: now + 60 * 60 * 1000,
      lastRefresh: now,
    },
  });
  const tokenContextId = await terminateBackground(
    driver,
    addonId,
    'OAuth token rebuild',
  );
  const tokenStatus = await sendExtensionMessage(driver, {
    type: 'mt:openai-oauth-status',
  });
  await waitForBackgroundRebuild(
    driver,
    addonId,
    tokenContextId,
    'OAuth token request listener',
  );
  if (
    tokenStatus?.ok !== true
    || tokenStatus.status?.authenticated !== true
    || tokenStatus.status.email !== 'lifecycle@example.invalid'
  ) {
    throw new Error(
      `Firefox OAuth token did not survive Event Page rebuild: ${
        JSON.stringify(tokenStatus)
      }`,
    );
  }
}

async function runInterruptedHostSmoke(driver, addonId, popupUrl) {
  await driver.switchTo().newWindow('tab');
  await driver.get(popupUrl);
  const interruptedHandle = await driver.getWindowHandle();
  await startInterruptiblePipelineProbe(driver);
  const previousContextId = await terminateBackground(
    driver,
    addonId,
    'active pipeline host loss',
  );
  await driver.wait(
    async () => {
      const probe = await readInterruptedPipelineProbe(driver);
      return probe?.disconnects === 1;
    },
    10_000,
    'Firefox active pipeline Port did not disconnect exactly once.',
  );
  const interrupted = await readInterruptedPipelineProbe(driver);
  if (
    interrupted.terminalMessages.length !== 0
    || interrupted.disconnects !== 1
  ) {
    throw new Error(
      `Firefox host loss delivered a live terminal result: ${
        JSON.stringify(interrupted)
      }`,
    );
  }

  await driver.switchTo().newWindow('tab');
  const providerEvidence = await runDirectPipelineProbe(driver, popupUrl);
  await waitForBackgroundRebuild(
    driver,
    addonId,
    previousContextId,
    'new execution after host loss',
  );
  await driver.switchTo().window(interruptedHandle);
  const afterNewExecution = await readInterruptedPipelineProbe(driver);
  if (
    afterNewExecution.disconnects !== 1
    || afterNewExecution.terminalMessages.length !== 0
  ) {
    throw new Error(
      `Firefox interrupted execution received a late terminal event: ${
        JSON.stringify(afterNewExecution)
      }`,
    );
  }
  return providerEvidence;
}

async function runStaleLeaseRebuildSmoke(
  driver,
  addonId,
  lifecycleFixture,
) {
  const handle = await openInlineFixture(
    driver,
    '/fixture/status/51-stale',
  );
  await clickInlineFixture(driver, handle);
  await withDeadline(
    lifecycleFixture.lifecycleFetchStarted,
    15_000,
    'Firefox active Header lease barrier',
  );
  const activeRules = await readHeaderOverrideRuleIds(driver, addonId);
  const activeLeaseIds = activeRules.session.filter(isHeaderLeaseRuleId);
  if (activeLeaseIds.length !== 1) {
    throw new Error(
      `Firefox active fetch did not hold one Header lease: ${
        JSON.stringify(activeRules)
      }`,
    );
  }

  const previousContextId = await terminateBackground(
    driver,
    addonId,
    'active fetch host loss',
  );
  lifecycleFixture.releaseLifecycleFetch();
  await waitForInlineResult(
    driver,
    handle,
    'Interrupted protected-image request',
    'error',
  );
  const ownerState = await driver.executeScript(`
    return {
      overlays: document.querySelectorAll('.mt-x-overlay-inline').length,
      status: document.querySelector(
        '.mt-x-overlay-inline .mt-x-control:not(.mt-x-control-secondary)'
      )?.dataset.status,
    };
  `);
  if (
    ownerState.overlays !== 1
    || ownerState.status !== 'error'
  ) {
    throw new Error(
      `Firefox background loss replaced content-owned page state: ${
        JSON.stringify(ownerState)
      }`,
    );
  }

  await clickInlineFixture(driver, handle);
  await waitForInlineResult(
    driver,
    handle,
    'Reconnected protected-image request',
    'translated',
    undefined,
    120_000,
  );
  await waitForBackgroundRebuild(
    driver,
    addonId,
    previousContextId,
    'network listener and Header lease cleanup',
  );
  const remainingRules = await readHeaderOverrideRuleIds(driver, addonId);
  if (remainingRules.session.some(isHeaderLeaseRuleId)) {
    throw new Error(
      `Firefox stale Header lease survived rebuilt network work: ${
        JSON.stringify(remainingRules)
      }`,
    );
  }
  return handle;
}

async function runIdleMenuWakeSmoke(driver, addonId, fixtureHandle) {
  await driver.switchTo().window(fixtureHandle);
  const fixtureImage = await driver.wait(
    until.elementLocated(By.css('img[alt="fixture manga"]')),
    5_000,
    'Firefox idle menu fixture did not remain loaded.',
  );
  const active = await readBackgroundSnapshot(driver, addonId);
  await waitForIdleUnload(driver, addonId, active.contextId);
  await driver.actions().contextClick(fixtureImage).perform();
  await driver.setContext(firefox.Context.CHROME);
  try {
    const menuCounts = await driver.wait(
      async () => {
        const counts = await driver.executeScript(`
          const labels = Array.from(document.querySelectorAll('menuitem'))
            .map((item) => item.label);
          return {
            image: labels.filter((label) => label === '翻译图片').length,
            screenshot: labels.filter((label) => label === '截图翻译').length,
          };
        `);
        return counts.image > 0 || counts.screenshot > 0 ? counts : false;
      },
      5_000,
      'Firefox native menus were not available after idle unload.',
    );
    if (menuCounts.image !== 1 || menuCounts.screenshot !== 1) {
      throw new Error(
        `Firefox native menus duplicated or disappeared after rebuild: ${
          JSON.stringify(menuCounts)
        }`,
      );
    }
    const stopped = await driver.executeScript(`
      const extension = WebExtensionPolicy.getByID(arguments[0])?.extension;
      return {
        contextId: extension?.backgroundContext?.contextId ?? null,
        state: extension?.backgroundState,
      };
    `, addonId);
    if (stopped.state !== 'stopped' || stopped.contextId !== null) {
      throw new Error(
        `Opening a persisted Firefox menu unexpectedly woke the Event Page: ${
          JSON.stringify(stopped)
        }`,
      );
    }
    await driver.executeScript(`
      const item = Array.from(document.querySelectorAll('menuitem'))
        .find((candidate) => candidate.label === '截图翻译');
      item.click();
    `);
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
  await driver.wait(
    until.elementLocated(By.css('.mt-x-screenshot-select')),
    10_000,
    'Firefox persisted menu listener did not wake after idle unload.',
  );
  await waitForBackgroundRebuild(
    driver,
    addonId,
    active.contextId,
    'native menu listener',
  );
  const screenshotEntries = await driver.findElements(
    By.css('.mt-x-screenshot-select'),
  );
  if (screenshotEntries.length !== 1) {
    throw new Error(
      `Firefox menu wake delivered ${screenshotEntries.length} selections.`,
    );
  }
  await driver.actions().sendKeys(Key.ESCAPE).perform();
}

async function runIdleRequestWakeSmoke(driver, addonId, popupUrl) {
  await driver.get('about:blank');
  const active = await readBackgroundSnapshot(driver, addonId);
  await waitForIdleUnload(driver, addonId, active.contextId);
  await driver.get(popupUrl);
  const settings = await sendExtensionMessage(driver, {
    type: 'mt:get-settings',
  });
  if (settings?.ok !== true || settings.type !== 'mt:get-settings') {
    throw new Error(
      `Firefox runtime request did not wake after idle unload: ${
        JSON.stringify(settings)
      }`,
    );
  }
  await waitForBackgroundRebuild(
    driver,
    addonId,
    active.contextId,
    'runtime request listener after idle unload',
  );
}

async function persistRestartState(driver) {
  const settingsResponse = await sendExtensionMessage(driver, {
    type: 'mt:get-settings',
  });
  if (settingsResponse?.ok !== true) {
    throw new Error(
      `Firefox restart setup could not read settings: ${
        JSON.stringify(settingsResponse)
      }`,
    );
  }
  const targetLang = settingsResponse.settings.targetLang === 'zh-CHS'
    ? 'zh-CHT'
    : 'zh-CHS';
  const saved = await sendExtensionMessage(driver, {
    type: 'mt:set-settings',
    settings: {
      ...settingsResponse.settings,
      targetLang,
      showElapsedTime: true,
    },
  });
  if (saved?.ok !== true || saved.settings.targetLang !== targetLang) {
    throw new Error(
      `Firefox restart setup could not persist settings: ${
        JSON.stringify(saved)
      }`,
    );
  }
  return {
    targetLang,
    tokenEmail: 'lifecycle@example.invalid',
  };
}

async function assertRestartState(
  driver,
  addonId,
  popupUrl,
  expected,
) {
  await driver.get(popupUrl);
  const settings = await sendExtensionMessage(driver, {
    type: 'mt:get-settings',
  });
  const oauth = await sendExtensionMessage(driver, {
    type: 'mt:openai-oauth-status',
  });
  if (
    settings?.ok !== true
    || settings.settings.targetLang !== expected.targetLang
    || oauth?.ok !== true
    || oauth.status?.authenticated !== true
    || oauth.status.email !== expected.tokenEmail
  ) {
    throw new Error(
      `Firefox browser restart did not restore persistent state: ${
        JSON.stringify({ settings, oauth })
      }`,
    );
  }
  const sessionState = await readExtensionStorage(driver, 'session', null);
  if (Object.keys(sessionState).length !== 0) {
    throw new Error(
      `Firefox browser restart restored non-persistent live state: ${
        JSON.stringify(sessionState)
      }`,
    );
  }
  const rules = await readHeaderOverrideRuleIds(driver, addonId);
  if (rules.session.length !== 0) {
    throw new Error(
      `Firefox browser restart restored session Header leases: ${
        JSON.stringify(rules)
      }`,
    );
  }
}

async function run() {
  await assertFirefoxPackage();
  const fixture = await startFixtureServer();
  const { server, networkRequests } = fixture;
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fixture server did not expose a TCP port.');
  }
  const firefoxBinary = await resolveFirefoxBinary();
  const headless = process.env.FIREFOX_HEADLESS !== 'false';
  const profileDirectory = await mkdtemp(
    join(tmpdir(), 'shinobu-firefox-lifecycle-'),
  );
  const createDriver = async () => {
    const options = new firefox.Options()
      .addArguments(...[
        ...(headless ? ['-headless'] : []),
        '-profile',
        profileDirectory,
        '--width=1280',
        '--height=900',
      ])
      .enableBidi()
      .setPreference(
        'network.dns.localDomains',
        'twitter.com,x.com,pbs.twimg.com',
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
    return await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .setFirefoxService(
        new firefox.ServiceBuilder().addArguments('--allow-system-access'),
      )
      .build();
  };

  let driver;
  let logInspector;
  const bidiLogs = [];
  const inspectLogs = async () => {
    logInspector = await LogInspector(driver);
    await logInspector.onLog((entry) => {
      bidiLogs.push(`${entry.level}: ${entry.text}`);
    });
  };
  try {
    driver = await createDriver();
    await inspectLogs();
    const addonId = await driver.installAddon(extensionRoot, true);
    if (addonId !== 'shinobu-translator@donutshinobu') {
      throw new Error(`Unexpected installed add-on id: ${addonId}`);
    }
    await grantDeclaredHostAccess(driver, addonId);
    const capabilities = await driver.getCapabilities();
    const browserVersion = String(
      capabilities.get('browserVersion') ?? 'unknown',
    );
    const browserMajorVersion = Number.parseInt(browserVersion, 10);
    const useDirectProbe = process.env.FIREFOX_DIRECT_PORT_PROBE === 'true'
      || browserMajorVersion <= 140;
    const supportsPackagedContentEntry = browserMajorVersion > 140;
    await runAuthenticationSmoke(driver, addonId);
    const popupUrl = await configurePipelineEvidence(driver, addonId);
    let concurrentA;
    let concurrentB;
    let rejected;
    let revoked;
    if (supportsPackagedContentEntry) {
      const pipelineHandle = await driver.getWindowHandle();
      concurrentA = await openInlineFixture(
        driver,
        '/fixture/status/49-a',
      );
      concurrentB = await openInlineFixture(
        driver,
        '/fixture/status/49-b',
        'x.com',
      );
      rejected = await openInlineFixture(
        driver,
        '/fixture/status/49-rejected',
      );
      revoked = await openInlineFixture(
        driver,
        '/fixture/status/49-revoked',
      );
      await driver.switchTo().window(pipelineHandle);
    }
    let directProviderEvidence;
    let runtimeProviders = [];
    if (useDirectProbe) {
      directProviderEvidence = await runDirectPipelineProbe(driver, popupUrl);
    } else {
      const windowCountBefore = (await driver.getAllWindowHandles()).length;
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
    await driver.actions()
      .move({ origin: fixtureImage, x: 20, y: 20 })
      .click()
      .sendKeys(Key.ENTER)
      .perform();

    const screenshotResult = await driver.wait(
      until.elementLocated(By.css('.mt-x-screenshot-result')),
      10_000,
      'Firefox screenshot selection did not start a local pipeline result.',
    );
    await driver.executeScript(`
      const result = arguments[0];
      window.__shinobuPipelineStatuses = [result.dataset.status || ''];
      new MutationObserver(() => {
        window.__shinobuPipelineStatuses.push(result.dataset.status || '');
      }).observe(result, {
        attributes: true,
        attributeFilter: ['data-status'],
      });
    `, screenshotResult);
    await driver.wait(
      async () => (
        await screenshotResult.getAttribute('data-status')
      ) === 'translated',
      120_000,
      'Firefox Event Page local pipeline did not return a screenshot result.',
    );
    const statuses = await driver.executeScript(
      'return window.__shinobuPipelineStatuses;',
    );
    if (
      !Array.isArray(statuses)
      || !statuses.includes('running')
      || !statuses.includes('translated')
    ) {
      throw new Error(
        `Firefox local pipeline did not expose running → translated UI state: ${
          JSON.stringify(statuses)
        }`,
      );
    }
    if (await screenshotResult.getAttribute('data-image') !== 'translated') {
      throw new Error(
        'Firefox local pipeline did not commit the returned screenshot image.',
      );
    }
    const resultImage = await screenshotResult.findElement(By.css('img'));
    if (!(await resultImage.getAttribute('src')).startsWith('blob:')) {
      throw new Error(
        'Firefox local pipeline screenshot result was not app-owned image data.',
      );
    }
      runtimeProviders = await screenshotResult.findElements(
        By.css('.mt-x-runtime-provider'),
      ).then((elements) => Promise.all(
        elements.map((element) => element.getText()),
      ));
    const expectedProvider = process.env.FIREFOX_EXPECTED_PROVIDER;
    if (
      expectedProvider
      && !runtimeProviders.some((provider) => provider.includes(expectedProvider))
    ) {
      throw new Error(
        `Firefox local pipeline did not use expected ${expectedProvider} provider: ${
          JSON.stringify(runtimeProviders)
        }`,
      );
    }
    if ((await driver.getAllWindowHandles()).length !== windowCountBefore) {
      throw new Error(
        'Firefox local pipeline unexpectedly created a dedicated extension page.',
      );
    }
    }

    let lifecycleFixtureHandle;
    if (supportsPackagedContentEntry) {
      networkRequests.length = 0;

      await clickInlineFixture(driver, concurrentA);
      await clickInlineFixture(driver, concurrentB);
      await waitForInlineResult(
        driver,
        concurrentA,
        'First concurrent protected-image request',
        undefined,
        undefined,
        120_000,
      );
      await waitForInlineResult(
        driver,
        concurrentB,
        'Second concurrent protected-image request',
        undefined,
        undefined,
        120_000,
      );
      const successfulNetworkRequests = networkRequests.filter(
        (request) => request.path === '/media/issue-49-a.png'
          || request.path === '/media/issue-49-b.png',
      );
      const concurrentARequest = successfulNetworkRequests.find(
        (request) => request.path === '/media/issue-49-a.png',
      );
      const concurrentBRequest = successfulNetworkRequests.find(
        (request) => request.path === '/media/issue-49-b.png',
      );
      if (
        successfulNetworkRequests.length !== 2
        || concurrentARequest?.referer !== 'http://twitter.com/'
        || concurrentARequest.status !== 200
        || concurrentBRequest?.referer !== 'http://x.com/'
        || concurrentBRequest.status !== 200
      ) {
        throw new Error(
          `Firefox protected-image concurrency did not preserve document Referers: ${
            JSON.stringify(successfulNetworkRequests)
          }`,
        );
      }

      await clickInlineFixture(driver, rejected);
      await waitForInlineResult(
        driver,
        rejected,
        'Rejected protected-image request',
        'error',
      );
      if (!networkRequests.some(
        (request) => request.path === '/media/issue-49-rejected.png'
          && request.status === 403,
      )) {
        throw new Error(
          'Firefox protected-image rejection was not exercised.',
        );
      }

      await revokeDeclaredHostAccess(driver, addonId);
      const revokedRequestStart = networkRequests.length;
      await clickInlineFixture(driver, revoked);
      await waitForInlineResult(
        driver,
        revoked,
        'Revoked host-permission request',
        'error',
        '(browser-rejected)',
      );
      if (networkRequests.slice(revokedRequestStart).some(
        (request) => request.path === '/media/issue-49-revoked.png',
      )) {
        throw new Error(
          'Firefox issued an image request after target host access was revoked.',
        );
      }

      const remainingRules = await readHeaderOverrideRuleIds(driver, addonId);
      const isHeaderOverrideRule = (id) => (
        id === 1
        || id === 2
        || isHeaderLeaseRuleId(id)
      );
      if (
        remainingRules.dynamic.some(isHeaderOverrideRule)
        || remainingRules.session.some(isHeaderOverrideRule)
      ) {
        throw new Error(
          `Firefox temporary Header override rules leaked: ${
            JSON.stringify(remainingRules)
          }`,
        );
      }
    }
    if (supportsPackagedContentEntry) {
      await grantDeclaredHostAccess(driver, addonId);
      console.log('[firefox-lifecycle] stale Header lease and content owner');
      lifecycleFixtureHandle = await runStaleLeaseRebuildSmoke(
        driver,
        addonId,
        fixture,
      );
    }

    const pipelineEvidence = useDirectProbe
      ? 'direct Event Page structured result and provider reports '
        + `(${directProviderEvidence})`
      : 'native screenshot Event Page result '
        + `(providers: ${runtimeProviders.join(', ') || 'not reported'})`;
    console.log('[firefox-lifecycle] OAuth callback and token rebuild');
    await runOAuthRebuildSmoke(driver, addonId, popupUrl);
    console.log('[firefox-lifecycle] active host disconnect and new task');
    const recoveredProviderEvidence = await runInterruptedHostSmoke(
      driver,
      addonId,
      popupUrl,
    );
    if (supportsPackagedContentEntry) {
      console.log('[firefox-lifecycle] real idle unload and native menu wake');
      await runIdleMenuWakeSmoke(
        driver,
        addonId,
        lifecycleFixtureHandle,
      );
    } else {
      console.log('[firefox-lifecycle] real idle unload and request wake');
      await runIdleRequestWakeSmoke(driver, addonId, popupUrl);
    }

    console.log('[firefox-lifecycle] real browser restart with active task');
    await driver.get(popupUrl);
    const restartState = await persistRestartState(driver);
    await startInterruptiblePipelineProbe(driver);
    await logInspector.close();
    logInspector = undefined;
    await driver.quit();
    driver = undefined;

    driver = await createDriver();
    await inspectLogs();
    const restartedAddonId = await driver.installAddon(extensionRoot, true);
    if (restartedAddonId !== addonId) {
      throw new Error(
        `Firefox browser restart changed the extension id: ${
          restartedAddonId
        }`,
      );
    }
    await grantDeclaredHostAccess(driver, restartedAddonId);
    await updateCredentialPermissions(driver, restartedAddonId, 'add', {
      authenticationInfo: true,
      cookies: true,
    });
    const restartedPopupUrl = await resolveExtensionUrl(
      driver,
      restartedAddonId,
      'popup.html',
    );
    if (typeof restartedPopupUrl !== 'string') {
      throw new Error(
        'Firefox browser restart did not expose the extension popup.',
      );
    }
    await assertRestartState(
      driver,
      restartedAddonId,
      restartedPopupUrl,
      restartState,
    );
    const restartedProviderEvidence = await runDirectPipelineProbe(
      driver,
      restartedPopupUrl,
    );
    console.log(
      `Firefox ${browserVersion} packaged smoke passed: ${pipelineEvidence}; `
        + (
          supportsPackagedContentEntry
            ? 'shared structured error UI, protected image success/rejection, '
              + 'host-permission revocation, concurrent and stale Header '
              + 'leases, content-owner reconnect, '
            : ''
        )
        + 'all credential modes, scoped permission revocation, real idle '
        + 'unload and listener wake, OAuth PKCE/token recovery, active host '
        + 'disconnect without late terminal delivery, and browser restart '
        + `followed by a new execution (${recoveredProviderEvidence}; `
        + `${restartedProviderEvidence}).`,
    );
  } catch (error) {
    console.error(
      `Firefox smoke failure: ${
        error instanceof Error ? error.stack : String(error)
      }`,
    );
    if (driver) {
      try {
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
      const inlineEntries = await driver.findElements(
        By.css('.mt-x-overlay-inline'),
      );
      if (inlineEntries.length > 0) {
        const button = await inlineEntries[0].findElement(
          By.css('.mt-x-control:not(.mt-x-control-secondary)'),
        );
        const detail = await inlineEntries[0].findElement(
          By.css('.mt-x-detail'),
        );
        console.error(
          `Firefox pipeline UI: status=${
            await button.getAttribute('data-status')
          }, detail=${await detail.getText()}`,
        );
      }
      const screenshotResults = await driver.findElements(
        By.css('.mt-x-screenshot-result'),
      );
      if (screenshotResults.length > 0) {
        const detail = await screenshotResults[0].findElement(
          By.css('.mt-x-detail'),
        );
        console.error(
          `Firefox screenshot pipeline UI: status=${
            await screenshotResults[0].getAttribute('data-status')
          }, detail=${await detail.getText()}`,
        );
      }
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
      } catch (diagnosticError) {
        console.error(
          `Firefox window diagnostics unavailable: ${
            diagnosticError instanceof Error
              ? diagnosticError.message
              : String(diagnosticError)
          }`,
        );
      }
    }
    throw error;
  } finally {
    if (logInspector) await logInspector.close();
    if (driver) await driver.quit();
    await closeServer(server);
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
