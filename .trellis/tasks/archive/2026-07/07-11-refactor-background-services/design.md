# Background 领域服务拆分设计

## 1. Composition Root

`background/index.ts` 仅负责：获取 Chrome API、构造 services、注册 runtime/tabs/contextMenus/commands listeners、把未知异常转换为统一响应。

## 2. 目标模块

```text
background/
├─ index.ts
├─ messages/
│  ├─ router.ts
│  └─ types.ts（仅在确有 Background 内部类型时）
├─ settings/settingsStore.ts
├─ diagnostics/logStore.ts
├─ openai/oauthService.ts
├─ openai/responsesProxy.ts
├─ gemini/authService.ts
├─ images/downloadService.ts
├─ images/captureService.ts
└─ menus/registerMenus.ts
```

现有 `geminiAppClient.ts`、`geminiApiImageClient.ts`、`llmProxy.ts` 保持协议客户端职责；只有当函数明显属于新 service 时才移动。

## 3. Router 契约

Router 接收 `RuntimeMessage`、sender 和注入的 `BackgroundServices`，返回 `Promise<RuntimeResponse>`。它不直接读取全局 Chrome，不注册 listener，也不吞掉客户端已定义的错误类型。

## 4. 服务边界

- Settings：读取、normalize、写入 storage。
- Diagnostics：追加、裁剪、导出、清空、run 聚合。
- OAuth：pending login、callback、refresh/revoke、token storage。
- Images：Referer rule、下载、base64、captureVisibleTab。
- Provider proxy：OpenAI Responses/chat completion、Gemini auth/image。
- Menus：menu/command 注册与 tab message。

## 5. 稳定数据

storage key、OAuth client/redirect、menu/command ID、DNR rule ID、`mt:*` 消息和错误文本保持不变。拆分不引入新的持久化格式。

## 6. 测试与回滚

服务通过最小接口注入 storage/fetch/chrome tabs，测试不依赖真实扩展。先提取纯函数/服务，再切换 router，最后缩减 index；每个领域可独立回滚。
