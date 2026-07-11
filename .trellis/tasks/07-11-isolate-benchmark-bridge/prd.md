# 隔离生产构建中的 Benchmark Bridge

## Goal

从 Release Content Script 移除可被宿主网页探测和调用的 bake/render `window.postMessage` 桥，同时保留浏览器 benchmark 的完整能力。

## Requirements

- `src/content/index.ts` 不再注册或广播 `__shinobu_bake*`、`__shinobu_render*` 协议。
- 新增仅在 benchmark 构建中存在的扩展页面入口，直接调用 `pipeline/bake`，不经过宿主网页消息桥。
- 浏览器 benchmark 脚本通过扩展 ID 打开该页面并调用受控 API。
- Release 构建不产出 benchmark 页面或入口脚本。
- 不改变站点适配、右键翻译、截图翻译和懒加载行为。
- 增加构建产物断言，防止桥协议再次进入 Release。

## Acceptance Criteria

- [x] Release `dist/content.js` 不含 benchmark request/response/ready 字符串。
- [x] Release `dist/` 不含 benchmark 专用页面和入口脚本。
- [x] benchmark build 可完成 `shinobuBake`、`shinobuRenderDebug` 和 fixture render。
- [x] `npm run build`、相关 benchmark smoke 和构建断言通过。
- [x] 宿主页面无法通过 `window.postMessage` 探测或调用扩展 benchmark 能力。

## Dependencies

- 无，可独立优先实施。

## Out of Scope

- 全面替换 Vite Content Script 插件。
- 改变 bake/render 算法和 fixture 格式。
- 缩小 `<all_urls>` 权限；该权限还服务于通用截图/悬停翻译。

## Notes

- 这是复杂任务，需在启动前审阅 design/implement。
