# Gemini App 会员额度端到端图片翻译设计

## 背景与决策

用户要求坚持“纯无感 + 使用 Gemini App 会员额度 + 不出现 Gemini 页面”。官方 Gemini API key / Paid Tier 不满足额度来源要求，可见 Gemini App 网页桥接也不满足体验要求。

GitHub 调研后，`HanaokaYuzu/Gemini-API` 是最适合作为技术参考的开源项目：它覆盖 Gemini Web 初始化、账号状态、模型发现、文件上传、图片生成/编辑、生成图解析和 cookie 刷新。由于项目是 Python 包，不能直接嵌入 Chrome MV3 扩展；本设计采用 TypeScript background 的最小协议移植。

该功能仅作为个人实验模式，默认关闭，不作为稳定官方能力承诺。

## 架构边界

- popup：新增实验开关、提示词模板、模式选择和风险提示。
- content script：继续负责从页面图片/截图得到 `File`，把图片 bytes 和上下文传给 background。
- background：新增固定消息 `mt:gemini-app-image-translate`，只执行 Gemini 图片翻译，不提供任意 URL 代理。
- shared：新增 Gemini App 实验配置、消息类型、响应类型和错误枚举。
- pipeline：现有本地 pipeline 保持不变；Gemini App 模式绕过 `runPipeline()`，直接返回生成图。

## 数据流

1. 用户点击翻译。
2. `TranslatorCore` 读取设置并判断图片处理引擎。
3. 本地模式：维持现状，调用 `runPipeline()`。
4. Gemini App 模式：把 `File` 转为 base64/ArrayBuffer，发送 `mt:gemini-app-image-translate`。
5. background 串行执行 Gemini App 请求。
6. background 返回 `{ base64, contentType, metadata }`。
7. content script 生成 blob URL，替换原图或展示截图浮层结果。

## Gemini App 最小协议移植

实现参考 `HanaokaYuzu/Gemini-API`，但只移植图片翻译所需子集：

- 初始化：请求 Gemini App 初始页面，取得 Web 请求所需 token/build/session 信息。
- 账号状态：检测未登录、地区不可用、账号受限、额度耗尽等状态并映射为中文错误。
- 上传：把源图上传到 Gemini Web 使用的上传端点，拿到文件引用。
- 生成：发送固定提示词，要求 Gemini 使用 Nano Banana Pro 对图片进行端到端翻译和嵌字。
- 解析：从响应结构提取第一张生成图片 URL 或完整尺寸 URL。
- 下载：background 下载生成图并返回 bytes。

## 认证策略

优先路径：

- background 对 `gemini.google.com` 和相关上传/下载域名发起固定请求。
- 尽量依赖浏览器已有登录态和 host permissions。
- 不把 cookie 值写入扩展设置、日志或调试导出。

Fallback（用户已允许）：

- 如果 credentialed fetch 不能携带可用登录态，可能需要 `chrome.cookies` 权限读取 `gemini.google.com` / `.google.com` 所需 cookie 并拼接请求。
- Chrome 官方文档要求使用 `chrome.cookies` API 时声明 `"cookies"` permission 和对应 host permissions。
- 若启用该 fallback，必须只在实验开关开启后读取固定 cookie 名称，内存中使用，不持久化。

## 设置模型

新增字段建议：

- `imageEngine: 'local' | 'gemini_app'`
- `geminiAppExperimentalEnabled: boolean`
- `geminiAppPromptTemplate: string`
- `geminiAppAuthMode: 'browser_session' | 'cookies_permission'`

`imageEngine` 独立于现有 `translator`，因为 Gemini App 模式不是文本翻译器，而是图片处理引擎。

## 错误模型

需要稳定映射这些错误：

- 未开启实验模式
- 未登录 Gemini
- Gemini App 不支持当前账号/地区/年龄
- Nano Banana Pro 不可用
- 额度耗尽
- 图片上传失败
- 生成超时
- 响应结构变化
- 未返回生成图
- 下载生成图失败

## 权限与安全

- `mt:gemini-app-image-translate` 不接受任意 URL。
- 请求目标只能是硬编码的 Gemini / Google 上传/图片下载端点。
- 默认串行执行，避免阅读模式批量快速消耗额度。
- 调试日志不得包含 cookie、token、完整私有请求载荷。
- popup 明确显示“实验功能，可能失效，可能消耗 Gemini App 图片额度”。

## 兼容性

- 本地 pipeline、Google Web 翻译、LLM 文本翻译、OpenAI OAuth 不受影响。
- 普通图片、右键图片和截图浮层可以接入 Gemini App 模式。
- 阅读模式批量入口 MVP 拒绝 Gemini App 模式，提示切回本地模式或单页处理。

## 主要风险

- Gemini Web 私有协议变更导致功能失效。
- Chrome extension background fetch 不一定能直接复用目标站登录态。
- 图片生成响应可能包含多候选、多媒体或需要额外轮询。
- MV3 service worker 生命周期可能中断长时间生成任务。
- 权限增加会显著提高用户敏感度，特别是 `cookies` 权限。

## 外部依据

- Chrome Extensions cross-origin requests：extension service worker 有 host permissions 时可以请求跨源服务器，同时必须避免把 content script 消息做成任意 URL fetch 代理。
- Chrome `cookies` API：使用 cookies API 需要 `"cookies"` permission 和目标 host permissions。
- `HanaokaYuzu/Gemini-API`：Gemini Web 非官方实现，支持图片生成/编辑和 cookie 刷新。
