# Windows Chrome CDP Benchmark 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 benchmark 的 bake/render 脚本从 Playwright 内置 Chromium 改为通过 CDP 连接 Windows 宿主机 Chrome，以使用 WebGPU。

**Architecture:** 新建 `chrome-cdp.ts` 共享模块负责启动 Windows Chrome（PowerShell 获取 PID）、等待 CDP 就绪、连接、关闭。两个脚本只需替换浏览器启动逻辑。

**Tech Stack:** Playwright（`connectOverCDP`）、PowerShell（进程管理）、`wslpath`（路径转换）

---

### Task 1: 创建 chrome-cdp.ts 共享模块

**Files:**
- Create: `scripts/benchmark/chrome-cdp.ts`

- [ ] **Step 1: 创建模块文件**

```ts
import { execSync, spawn } from "child_process";
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
```

- [ ] **Step 2: 验证模块语法**

Run: `npx tsx --eval "import './scripts/benchmark/chrome-cdp.ts'" 2>&1`
Expected: 无语法错误（不会实际启动 Chrome）

- [ ] **Step 3: Commit**

```bash
git add scripts/benchmark/chrome-cdp.ts
git commit -m "feat(bench): add chrome-cdp module for Windows Chrome CDP connection"
```

---

### Task 2: 改造 bake-fixtures.ts

**Files:**
- Modify: `scripts/benchmark/bake-fixtures.ts`

- [ ] **Step 1: 替换浏览器启动逻辑**

删除以下导入和逻辑：
- `import { chromium } from "playwright"` → 删除
- manifest 补丁代码块（第 114-134 行）→ 移除（已在 chrome-cdp.ts 的 `--load-extension` 参数中处理）
- `chromium.launchPersistentContext(...)` 及等待 service worker 的代码 → 替换

添加导入：
```ts
import { launchWindowsChrome } from "./chrome-cdp";
```

替换 `main()` 中的浏览器启动部分为：
```ts
  console.log("Building extension...");
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

  // Patch manifest for localhost content script
  const manifestPath = join(DIST_DIR, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.content_scripts[0].matches = ["http://localhost/*", ...manifest.content_scripts[0].matches];
  if (!manifest.host_permissions) manifest.host_permissions = [];
  if (!manifest.host_permissions.includes("http://localhost/*")) {
    manifest.host_permissions.push("http://localhost/*");
  }
  if (!manifest.permissions) manifest.permissions = [];
  if (!manifest.permissions.includes("scripting")) {
    manifest.permissions.push("scripting");
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    if (!war.matches.includes("http://localhost/*")) {
      war.matches.push("http://localhost/*");
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const { browser, close: closeBrowser } = await launchWindowsChrome(DIST_DIR);
```

替换结尾的关闭逻辑：
```ts
  // 原: await browser.close();
  await closeBrowser();
  server.close();
  console.log("Bake complete.");
```

同时删除不再需要的 `chromium` 导入。将 `browser.newPage()` 改为通过默认 context：
```ts
  const context = browser.contexts()[0];
```

然后将所有 `browser.newPage()` 替换为 `context.newPage()`。

- [ ] **Step 2: 等待 service worker 逻辑调整**

连接已有 Chrome 时，扩展可能已经加载。保留等待逻辑但改为用 context：
```ts
  // Wait for extension service worker
  const sws = context.serviceWorkers();
  console.log(`Service workers: ${sws.length}`);
  if (sws.length === 0) {
    const sw = await context.waitForEvent("serviceworker", { timeout: 10_000 }).catch(() => null);
    console.log(`Waited for SW: ${sw ? "found" : "none"}`);
  }
```

- [ ] **Step 3: 运行测试**

Run: `npm run bench:bake`
Expected: 成功启动 Windows Chrome、加载扩展、处理图片、生成 fixture、关闭 Chrome（只关闭测试 PID）

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark/bake-fixtures.ts
git commit -m "refactor(bench): bake-fixtures uses Windows Chrome via CDP"
```

---

### Task 3: 改造 render-result.ts

**Files:**
- Modify: `scripts/benchmark/render-result.ts`

- [ ] **Step 1: 替换浏览器启动逻辑**

同 Task 2 的模式。删除 `chromium` 导入，添加 `launchWindowsChrome` 导入。

替换浏览器启动：
```ts
  console.log("Building extension...");
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

  const manifestPath = join(DIST_DIR, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.content_scripts[0].matches = ["http://localhost/*", ...manifest.content_scripts[0].matches];
  if (!manifest.host_permissions) manifest.host_permissions = [];
  if (!manifest.host_permissions.includes("http://localhost/*")) {
    manifest.host_permissions.push("http://localhost/*");
  }
  if (!manifest.permissions) manifest.permissions = [];
  if (!manifest.permissions.includes("scripting")) {
    manifest.permissions.push("scripting");
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    if (!war.matches.includes("http://localhost/*")) {
      war.matches.push("http://localhost/*");
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const { browser, close: closeBrowser } = await launchWindowsChrome(DIST_DIR);
  const context = browser.contexts()[0];

  const sws = context.serviceWorkers();
  if (sws.length === 0) {
    await context.waitForEvent("serviceworker", { timeout: 10_000 }).catch(() => null);
  }
```

替换结尾关闭：
```ts
  await closeBrowser();
  server.close();
```

将 `browser.newPage()` 改为 `context.newPage()`。

- [ ] **Step 2: 运行测试**

Run: `npm run bench:render`
Expected: 成功渲染图片到 reports 目录

- [ ] **Step 3: Commit**

```bash
git add scripts/benchmark/render-result.ts
git commit -m "refactor(bench): render-result uses Windows Chrome via CDP"
```
