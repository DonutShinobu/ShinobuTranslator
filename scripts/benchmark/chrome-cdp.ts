import { execSync } from "child_process";
import { chromium, type Browser } from "playwright";

const CHROME_PATH_WIN = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const CMD = "/mnt/c/Windows/System32/cmd.exe";
const TASKKILL = "/mnt/c/Windows/System32/taskkill.exe";
const CDP_PORT = 9222;

const EXT_DIR_WIN = "D:\\Downloads\\ShinobuTranslator";
const USER_DATA_DIR_WIN = "D:\\Downloads\\shinobu-bench-profile";

export interface ChromeCDP {
  browser: Browser;
  close(): Promise<void>;
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
  // Sync build output to the fixed extension directory
  const extDirWsl = execSync(`wslpath -u "${EXT_DIR_WIN}"`, { encoding: "utf-8" }).trim();
  execSync(`rsync -a --delete "${distDir}/" "${extDirWsl}/"`);

  const pidOutput = execSync(
    `${POWERSHELL} -Command "` +
      `\\$p = Start-Process -FilePath '${CHROME_PATH_WIN}' -PassThru -ArgumentList ` +
      `'--remote-debugging-port=${CDP_PORT}',` +
      `'--user-data-dir=${USER_DATA_DIR_WIN}',` +
      `'--no-first-run',` +
      `'--no-default-browser-check'; ` +
      `\\$p.Id"`,
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
        execSync(`${TASKKILL} /PID ${pid} /T /F`, { stdio: "ignore" });
      } catch {}
    },
  };
}
