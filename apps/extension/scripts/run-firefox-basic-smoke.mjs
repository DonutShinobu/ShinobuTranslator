#!/usr/bin/env node
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
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
      const delay = requestUrl.pathname === '/media/issue-49-a.png'
        && requestCount > 1
        ? 250
        : 0;
      setTimeout(() => response.end(onePixelPng), delay);
      return;
    }

    const issue49Match = /^\/fixture\/status\/(49-(?:a|b|rejected|revoked))$/u
      .exec(requestUrl.pathname);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      ...(issue49Match ? { 'Referrer-Policy': 'origin' } : {}),
    });
    const fixtureId = issue49Match?.[1] ?? '47';
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
  await option.click();
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

async function waitForInlineFailure(driver, handle, label, expectedDetail) {
  await driver.switchTo().window(handle);
  const inlineButton = await driver.findElement(
    By.css('.mt-x-overlay-inline .mt-x-control:not(.mt-x-control-secondary)'),
  );
  await driver.wait(
    async () => (
      await inlineButton.getAttribute('data-status')
    ) === 'error',
    30_000,
    `${label} did not reach the shared structured error UI.`,
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

async function run() {
  await assertFirefoxPackage();
  const fixture = await startFixtureServer();
  const { server, networkRequests } = fixture;
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
    await runAuthenticationSmoke(driver, addonId);

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

    const concurrentA = await openInlineFixture(
      driver,
      '/fixture/status/49-a',
    );
    const concurrentB = await openInlineFixture(
      driver,
      '/fixture/status/49-b',
      'x.com',
    );
    const rejected = await openInlineFixture(
      driver,
      '/fixture/status/49-rejected',
    );
    const revoked = await openInlineFixture(
      driver,
      '/fixture/status/49-revoked',
    );
    networkRequests.length = 0;

    await clickInlineFixture(driver, concurrentA);
    await clickInlineFixture(driver, concurrentB);
    await waitForInlineFailure(
      driver,
      concurrentA,
      'First concurrent protected-image request',
    );
    await waitForInlineFailure(
      driver,
      concurrentB,
      'Second concurrent protected-image request',
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
    await waitForInlineFailure(
      driver,
      rejected,
      'Rejected protected-image request',
    );
    if (!networkRequests.some(
      (request) => request.path === '/media/issue-49-rejected.png'
        && request.status === 403,
    )) {
      throw new Error('Firefox protected-image rejection was not exercised.');
    }

    await revokeDeclaredHostAccess(driver, addonId);
    const revokedRequestStart = networkRequests.length;
    await clickInlineFixture(driver, revoked);
    await waitForInlineFailure(
      driver,
      revoked,
      'Revoked host-permission request',
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
      || (id >= 1_000_000 && id <= 1_999_999)
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

    console.log(
      'Firefox packaged smoke passed: add-on install, inline image entry, '
        + 'shared retry UI, native screenshot menu interaction, protected '
        + 'image success/rejection, host-permission revocation, concurrent '
        + 'Header leases, cleanup, all credential modes, and scoped '
        + 'credential permission revocation.',
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
