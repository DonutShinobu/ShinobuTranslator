# Benchmark Bridge 隔离设计

## 1. 当前问题

`src/content/index.ts` 在所有注入页面中接收和发送 benchmark `window.postMessage`，Release `content.js` 因而暴露 ready/request/response 协议。宿主页面与扩展 isolated world 虽不共享普通 JS 属性，但 `postMessage` 会跨 world 传递。

## 2. 目标方案

- 新增 benchmark-only extension page，例如 `benchmark.html` + `src/benchmark/browserEntry.ts`。
- benchmark entry 在扩展页面上下文直接导入 `pipeline/bake` 与 `browserPlatform`，向 Playwright `page.evaluate` 暴露受控 API。
- 通过明确的 benchmark build 命令/环境开关把该页面加入 Vite input。
- 普通 `npm run build` 和 GitHub Release 不包含 benchmark input。
- 浏览器 benchmark 在加载扩展后获取 extension ID，直接导航到 `chrome-extension://<id>/benchmark.html`。

## 3. API 边界

受控页面只需要暴露：

- `bake(dataUrl)`
- `render(dataUrl)`
- `renderDebug(dataUrl)`
- `renderFixtureDebug(dataUrl, regions)`

API 只存在于 benchmark extension page，不使用宿主页面消息，也不进入 Content Script 全局。

## 4. 构建契约

- Release build：三入口 popup/background/content + 独立 ONNX Worker，不含 benchmark page。
- Benchmark build：在 Release 入口基础上额外产生 benchmark page/entry。
- build-worker 语义不变。
- 构建产物检查同时验证禁用协议字符串和 benchmark 文件缺失。

## 5. 兼容与回滚

- `pipeline/bake.ts` API 与 fixture 格式保持不变。
- benchmark runner 迁移失败时可回滚 runner 和 benchmark input，而不恢复生产 Content Bridge；生产边界修复不可由 benchmark 便利性倒退。
- 不修改 Manifest 权限或站点 Content 功能。
