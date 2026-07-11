# 拆分 Background 领域服务

## Goal

把 Background Service Worker 从单文件多职责入口重构为可独立测试的消息路由和领域服务，同时保持所有 Chrome 消息、设置、认证和网络行为兼容。

## Requirements

- `background/index.ts` 只负责初始化、Chrome listener 注册和顶层错误处理。
- 消息路由、设置存储、诊断日志、OpenAI OAuth、Gemini、图片下载/截图、LLM 代理和菜单/命令分别归属明确模块。
- 消息 handler 可注入服务依赖并在无真实 Chrome 环境下测试。
- 保持全部 `mt:*` discriminant、成功/失败响应形状和错误细节。
- 保持 OAuth token/storage key、Pixiv Referer 规则和 context menu/command ID。
- 不在本任务修改 Popup 或 Content 调用协议。

## Acceptance Criteria

- [x] `background/index.ts` 仅包含组合和 listener 注册，不再包含领域实现。
- [x] 每个消息域有直接行为测试，覆盖成功、校验失败和外部错误保真。
- [x] 现有 background 客户端测试继续通过。
- [x] OpenAI OAuth、Gemini 登录/译图、图片下载、截图、诊断日志和菜单命令行为保持兼容。
- [x] 完整 typecheck/test/build 通过。

## Dependencies

- 必须先完成 `07-11-engineering-quality-gates`。
- 可与 Content 子任务独立实施，但不得同时修改共享消息契约。

## Out of Scope

- 更换 OAuth 流程或 Provider API。
- 改变设置格式、权限或用户可见错误文本。

## Notes

- 以领域边界和可测试性为拆分依据，不按固定行数机械切文件。
