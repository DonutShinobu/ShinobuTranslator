# Background 领域服务实施计划

## 1. Characterization

- [x] 以 `RuntimeMessage` discriminant 和 typed router 为各消息域建立请求/响应清单。
- [x] 增加设置、诊断、OAuth、图片、LLM/Gemini、菜单的关键行为测试。
- [x] 固定 storage keys、rule ID 1、menu/command IDs 和外部错误保真。

## 2. 基础边界

- [x] 定义 `BackgroundServices` 最小依赖接口。
- [x] 提取可独立调用的 typed router。
- [x] 保持 `shared/messages.ts` 公共契约不变。

## 3. 按领域迁移

- [x] 提取 settings store。
- [x] 提取 diagnostic log store/export。
- [x] 提取 OpenAI OAuth service 与 Responses proxy。
- [x] 提取 image download/capture 与 Referer rule。
- [x] 组合 Gemini/LLM client services。
- [x] 提取 menu/command 注册。

## 4. 收敛入口

- [x] `background/index.ts` 从 1429 行收敛为 116 行，只保留 composition root、初始化和 listeners。
- [x] 移除重复 helper，保持客户端错误类型、Gemini raw error detail 和响应形状。

## 5. 验证

- [x] Background/shared 定向测试 57 项通过，并覆盖所有消息域及菜单/快捷键转发。
- [x] 完整 `npm run check` 通过：三套 typecheck、38 个测试文件/535 项测试、Release build 和 artifact boundary check。
- [x] Chrome API 行为通过注入式 service/menu 测试验证；真实网络认证不在自动测试中触发，原协议与 key 保持不变。
- [x] `git diff --check` 通过，`shared/messages.ts` 未修改，用户的 `benchmark/images/` 未纳入变更。

## 6. 回滚点

- [x] Router、各 service、index 形成清晰文件级变更组；未在用户确认前自动提交。
- [x] 各领域可按模块恢复，不需回滚其他已验证 service。
