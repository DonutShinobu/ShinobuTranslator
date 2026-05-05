import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { chromium, type Browser } from "playwright";

const CHROME_PATH_WIN = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const CDP_PORT = 9222;

export interface ChromeCDP {
  browser: Browser;
  close(): Promise<void>;
}

function toWindowsPath(wslPath: string): string {
  return execSync(`wslpath -w "${wslPath}"`, { encoding: "utf-8" }).trim();
}

async function waitForCDP(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`CDP not ready on port ${port} after ${timeoutMs}ms`);
}

export async function launchWindowsChrome(distDir: string): Promise<ChromeCDP> {
  const distWin = toWindowsPath(distDir);
  const userDataDir = mkdtempSync(join(tmpdir(), "shinobu-bench-"));
  const userDataDirWin = toWindowsPath(userDataDir);

  const pidOutput = execSync(
    `powershell.exe -Command "` +
      `$p = Start-Process -FilePath '${CHROME_PATH_WIN}' -PassThru -ArgumentList ` +
      `'--remote-debugging-port=${CDP_PORT}',` +
      `'--user-data-dir=${userDataDirWin}',` +
      `'--disable-extensions-except=${distWin}',` +
      `'--load-extension=${distWin}',` +
      `'--no-first-run',` +
      `'--no-default-browser-check'; ` +
      `$p.Id"`,
    { encoding: "utf-8" },
  ).trim();
  const pid = parseInt(pidOutput, 10);
  if (isNaN(pid)) throw new Error(`Failed to get Chrome PID: ${pidOutput}`);
  console.log(`Chrome started (PID ${pid}), waiting for CDP...`);

  await waitForCDP(CDP_PORT);
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
  console.log("Connected to Chrome via CDP.");

  return {
    browser,
    async close() {
      await browser.close();
      try {
        execSync(`taskkill.exe /PID ${pid} /T /F`, { stdio: "ignore" });
      } catch {}
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    },
  };
}
