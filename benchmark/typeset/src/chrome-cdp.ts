import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { chromium, type BrowserContext, type Page } from "playwright";

const USER_DATA_DIR = process.env.SHINOBU_BENCH_PROFILE_DIR
  ? resolve(process.env.SHINOBU_BENCH_PROFILE_DIR)
  : join(tmpdir(), "shinobu-bench-profile");

export type ChromeCDP = {
  context: BrowserContext;
  extensionId: string;
  close(): Promise<void>;
};

export async function launchWindowsChrome(distDir: string): Promise<ChromeCDP> {
  const extensionDir = resolve(distDir);
  if (!existsSync(extensionDir)) {
    throw new Error(`Extension dist directory not found: ${extensionDir}`);
  }

  if (process.env.SHINOBU_BENCH_KEEP_PROFILE !== "1") {
    rmSync(USER_DATA_DIR, { recursive: true, force: true });
  }
  mkdirSync(USER_DATA_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chromium",
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  console.log(`Benchmark browser started with Playwright Chromium; profile: ${USER_DATA_DIR}`);

  const worker = context.serviceWorkers()[0]
    ?? await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const extensionId = new URL(worker.url()).hostname;
  if (!extensionId) {
    await context.close();
    throw new Error(`Unable to resolve extension id from service worker URL: ${worker.url()}`);
  }

  return {
    context,
    extensionId,
    async close() {
      await context.close();
    },
  };
}

export async function openBenchmarkPage(chrome: ChromeCDP): Promise<Page> {
  const page = await chrome.context.newPage();
  page.setDefaultTimeout(600_000);
  await page.goto(`chrome-extension://${chrome.extensionId}/benchmark.html`, {
    waitUntil: "load",
  });
  await page.waitForFunction(() => Boolean(
    (window as typeof window & { __shinobuBenchmark__?: unknown }).__shinobuBenchmark__,
  ));
  return page;
}
