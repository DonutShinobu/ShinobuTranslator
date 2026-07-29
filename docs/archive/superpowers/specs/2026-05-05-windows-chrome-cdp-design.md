# 设计：Benchmark 脚本改用 Windows 宿主机 Chrome（CDP）

## 背景

`bake-fixtures.ts` 和 `render-result.ts` 通过 Playwright 启动 Chromium 加载扩展，调用 `shinobuBake`/`shinobuRender`（依赖 WebGPU 运行 ONNX 模型）。WSL 内置 Chromium 无法使用 WebGPU，需要改为连接 Windows 宿主机上的 Chrome。

## 改动范围

### 新增文件

**`scripts/benchmark/chrome-cdp.ts`** — 共享工具模块，负责：

1. **启动 Windows Chrome**
   - 路径：`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`
   - 通过 `powershell.exe -Command "Start-Process ... -PassThru | Select-Object -ExpandProperty Id"` 启动并获取 PID
   - 启动参数：
     - `--remote-debugging-port=9222`
     - `--user-data-dir=<临时目录>`（隔离会话，避免与宿主机已运行的 Chrome 冲突）
     - `--disable-extensions-except=<dist Windows 路径>`
     - `--load-extension=<dist Windows 路径>`
   - `dist` 路径通过 `wslpath -w` 转换为 Windows 路径

2. **等待 CDP 就绪**
   - 轮询 `http://localhost:9222/json/version`，超时 15 秒
   - 每 500ms 重试一次

3. **连接**
   - 调用 `chromium.connectOverCDP("http://localhost:9222")` 返回 `Browser` 实例

4. **关闭**
   - `taskkill /PID <pid> /T /F`（只杀启动时记录的 PID 及其子进程树）
   - 清理临时 user-data-dir

导出接口：

```ts
interface ChromeCDP {
  browser: Browser;
  close(): Promise<void>;
}

export async function launchWindowsChrome(distDir: string): Promise<ChromeCDP>;
```

### 修改文件

**`bake-fixtures.ts`**
- 删除 `chromium.launchPersistentContext(...)` 及相关的 manifest 补丁逻辑
- 改为调用 `launchWindowsChrome(DIST_DIR)` 获取 browser
- manifest 补丁移入 `launchWindowsChrome` 内部（build 之后、启动 Chrome 之前执行）
- 其余逻辑（page 操作、postMessage bridge、fixture 写入）不变

**`render-result.ts`**
- 同上，替换浏览器启动方式

### 不变的文件

- `run-bench.ts` — 纯 Node.js 计算，无浏览器依赖
- `visualize.ts` — 同上
- `src/pipeline/bake.ts` — 运行在浏览器中的逻辑，不需改
- `src/content/index.ts` — content script bridge，不需改

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 进程管理 | PowerShell `-PassThru` 获取 PID | 精确 kill，不误杀宿主机其他 Chrome |
| 会话隔离 | 临时 `--user-data-dir` | 避免与已运行 Chrome 的 profile lock 冲突 |
| 路径转换 | `wslpath -w` | WSL 路径 → Windows 路径，Chrome 在 Windows 侧运行 |
| CDP 端口 | 固定 9222 | 简单，Playwright 默认端口 |
| manifest 补丁 | 在 `launchWindowsChrome` 内部做 | 避免两个脚本重复补丁逻辑 |

## 风险

- **端口占用**：如果 9222 已被占用，启动会失败。可以在错误信息中提示用户检查。
- **临时目录清理**：Chrome 异常退出时临时目录可能残留。使用 `os.tmpdir()` 下的子目录，系统最终会清理。
