import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { applyExtensionControlPatch } from './extension-control-driver';
import { ensureExtensionDistReady } from './dist-contract';

declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<Array<{ id?: number; url?: string }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  runtime: {
    getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
  };
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DIST_DIR = join(ROOT, 'apps', 'extension', 'dist-chromium');
const TMP_DIR = join(ROOT, '.tmp');
const USER_DATA_DIR = join(TMP_DIR, `browser-offscreen-smoke-${Date.now()}`);
const DEFAULT_IMAGE = join(ROOT, 'benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png');

type DiagnosticEvent = {
  message?: string;
  category?: string;
  source?: { context?: string };
  data?: Record<string, unknown>;
};

function requireFile(path: string): void {
  if (!existsSync(path)) throw new Error(`Missing required smoke asset: ${path}`);
}

function pickImagePath(): string {
  const argument = process.argv.find((value) => value.startsWith('--image='));
  const path = argument ? resolve(argument.slice('--image='.length)) : DEFAULT_IMAGE;
  requireFile(path);
  return path;
}

async function startStrictCspServer(imagePath: string): Promise<{ server: Server; url: string }> {
  const image = readFileSync(imagePath);
  const server = createServer((request, response) => {
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'none'; worker-src 'none'; img-src 'self' blob:; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'",
    );
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/fixture.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(image);
      return;
    }
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>Shinobu strict CSP offscreen smoke</title>
    <style>body{margin:0;padding:24px;background:#eee}img{display:block;max-width:900px;height:auto}</style>
  </head>
  <body><img id="source" src="/fixture.png" alt="fixture"></body>
</html>`);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to read smoke server address');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function getRuntimeModels(events: DiagnosticEvent[]): string[] {
  const artifactEvent = [...events].reverse().find((event) => event.message === '本地 pipeline artifacts 已汇总');
  const runtimeStages = artifactEvent?.data?.runtimeStages;
  if (!Array.isArray(runtimeStages)) return [];
  return runtimeStages
    .map((stage) => stage && typeof stage === 'object' ? (stage as { model?: unknown }).model : undefined)
    .filter((model): model is string => typeof model === 'string');
}

async function main(): Promise<void> {
  ensureExtensionDistReady(DIST_DIR);
  mkdirSync(USER_DATA_DIR, { recursive: true });
  const imagePath = pickImagePath();
  const { server, url } = await startStrictCspServer(imagePath);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: chromium.executablePath(),
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${DIST_DIR}`,
      `--load-extension=${DIST_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--enable-unsafe-webgpu',
    ],
  });
  context.setDefaultTimeout(600_000);

  try {
    const page = await context.newPage();
    page.on('console', (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
    await page.goto(url, { waitUntil: 'load' });

    const serviceWorker = context.serviceWorkers()[0]
      ?? await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = serviceWorker.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    if (!extensionId) throw new Error(`Unable to parse extension id: ${serviceWorker.url()}`);

    await applyExtensionControlPatch(context, extensionId, {
      patch: {
        imageEngine: 'local',
        processMode: 'original',
        enableDebugLog: true,
        showElapsedTime: true,
        showStageTimingDetails: true,
        showTypesetDebug: false,
        showEraseDebug: false,
      },
      clearDiagnosticLog: true,
    });

    const image = page.locator('#source');
    await image.waitFor({ state: 'visible' });
    await image.hover();

    const response = await serviceWorker.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url === pageUrl);
      if (typeof tab?.id !== 'number') throw new Error(`Unable to find smoke tab: ${pageUrl}`);
      return chrome.tabs.sendMessage(tab.id, { type: 'mt:shortcut-translate-hover' });
    }, url);
    if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) {
      throw new Error(`Content pipeline failed: ${JSON.stringify(response)}`);
    }

    const translated = page.locator('.mt-x-screenshot-result[data-status="translated"][data-image="translated"] img');
    await translated.waitFor({ state: 'visible' });
    const translatedImage = await translated.evaluate((element) => {
      const imageElement = element as HTMLImageElement;
      return {
        src: imageElement.src,
        naturalWidth: imageElement.naturalWidth,
        naturalHeight: imageElement.naturalHeight,
      };
    });
    if (!translatedImage.src.startsWith('blob:') || translatedImage.naturalWidth <= 0 || translatedImage.naturalHeight <= 0) {
      throw new Error(`Translated image is invalid: ${JSON.stringify(translatedImage)}`);
    }

    const offscreenContexts = await serviceWorker.evaluate(async () => {
      if (!chrome.runtime.getContexts) return [];
      return chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    });
    if (!Array.isArray(offscreenContexts) || offscreenContexts.length !== 1) {
      throw new Error(`Expected one offscreen context, received: ${JSON.stringify(offscreenContexts)}`);
    }

    const events = await serviceWorker.evaluate(async () => {
      const saved = await chrome.storage.local.get('mangaTranslate.diagnosticLog');
      const store = saved['mangaTranslate.diagnosticLog'];
      const eventsValue = store && typeof store === 'object'
        ? (store as { events?: unknown }).events
        : undefined;
      return Array.isArray(eventsValue) ? eventsValue : [];
    }) as DiagnosticEvent[];
    const directWorkerSuccess = events.some((event) => {
      const attempt = event.data?.attempt;
      return event.category === 'model.runtime'
        && event.data?.kind === 'worker-bootstrap-complete'
        && attempt !== null
        && typeof attempt === 'object'
        && !Array.isArray(attempt)
        && (attempt as Record<string, unknown>).mode === 'direct'
        && (attempt as Record<string, unknown>).status === 'success';
    });
    if (!directWorkerSuccess) {
      throw new Error('Diagnostic log is missing the structured direct Worker success event');
    }
    const blobAttempt = events.find((event) => {
      const attempt = event.data?.attempt;
      return event.category === 'model.runtime'
        && attempt !== null
        && typeof attempt === 'object'
        && !Array.isArray(attempt)
        && (attempt as Record<string, unknown>).mode === 'blob';
    });
    if (blobAttempt) {
      throw new Error(`Extension runtime unexpectedly attempted a Blob Worker: ${JSON.stringify(blobAttempt)}`);
    }
    const runtimeModels = getRuntimeModels(events);
    for (const expectedModel of ['detector', 'bubble', 'ocr', 'inpaint']) {
      if (!runtimeModels.includes(expectedModel)) {
        throw new Error(`Runtime summary is missing ${expectedModel}: ${JSON.stringify(runtimeModels)}`);
      }
    }
    const pipelineCategories = ['pipeline.detect', 'pipeline.bubble', 'pipeline.ocr', 'pipeline.inpaint'];
    for (const category of pipelineCategories) {
      if (!events.some((event) => event.category === category && event.source?.context === 'pipeline-host')) {
        throw new Error(`Diagnostic log is missing pipeline-host category ${category}`);
      }
    }
    const heartbeat = events
      .map((event) => event.data?.progressJank)
      .find((value) => value && typeof value === 'object') as {
        observerSupport?: { workerHeartbeatMode?: string; workerHeartbeatCsp?: unknown };
      } | undefined;
    if (heartbeat?.observerSupport?.workerHeartbeatMode !== 'blocked-by-csp') {
      throw new Error(`Worker heartbeat CSP classification is missing: ${JSON.stringify(heartbeat)}`);
    }

    console.log(JSON.stringify({
      extensionId,
      browser: 'Playwright Chromium',
      pageUrl: url,
      image: imagePath,
      translatedImage,
      offscreenContextCount: offscreenContexts.length,
      runtimeModels,
      pipelineCategories,
      workerHeartbeatMode: heartbeat.observerSupport.workerHeartbeatMode,
      diagnosticEventCount: events.length,
    }, null, 2));
  } finally {
    await context.close();
    await closeServer(server);
  }
}

await main();
