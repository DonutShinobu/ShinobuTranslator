# 构建结构化日志系统

## Goal

为 ShinobuTranslator 构建一个完整、结构化、可下载的调试日志系统。用户在 popup 的调试选项中勾选“日志记录”后，扩展应在一次翻译会话中收集 content、background、popup、pipeline、模型运行、大模型 API 调用、Chrome API / 存储 / 消息通信等关键事件，并通过 popup 的单一入口下载一份统一 `.log` 文本诊断日志。

核心用户价值是让开发者能通过用户导出的日志定位问题，而不是要求用户打开 DevTools 或分别寻找页面内“下载日志”、background 控制台、popup 控制台等分散线索。当前直接动机是有用户使用 DeepSeek 翻译时遇到“翻译失败: Failed to fetch”，现有日志无法判断是 CORS、网络不可达、API endpoint、请求体、响应状态、权限或扩展上下文问题。

## Confirmed Facts

- 现有配置中已有 `enableDebugLog`，默认关闭，并在 popup 的“调试选项”里显示为“日志记录”。
- 现有 content 图片悬浮 UI 有“下载日志”按钮，但它只依赖单张图片状态里的 `debugLogData`，不是 popup 的统一入口。
- 现有 debug log 主要围绕 typeset debug、OCR debug、stage timings、runtime stages、progress jank 等局部数据，尚未覆盖完整运行链路。
- 普通图片翻译失败时，content catch 会把 `state.debugLogData` 清空；`PipelineStageError` 虽然携带 artifacts，但失败 artifacts 没有被统一导出。
- 非 OpenAI OAuth 的大模型翻译请求目前在 content 侧直接 `fetch(baseUrl/chat/completions)`；`Failed to fetch` 这类错误不会附带 provider、endpoint、耗时、请求大小、响应状态或失败分类。
- OpenAI OAuth 请求走 background proxy；Gemini App / Gemini API 图像翻译也走 background，但只有 Gemini raw response 有局部 `errorDetail` 特例。
- ONNX runtime、worker、detector、OCR、inpaint、reading-order 等处存在散落的 `console.warn/info`，包括 WebNN/WebGPU/WASM fallback 和 GPU 失败回退。
- background 已有 `chrome.storage.local` 包装函数，可以作为日志环形缓冲或最新日志包的持久化基础。

## Requirements

- 提供一个统一日志入口：popup 中的“下载日志”按钮下载同一份文本诊断日志；不再依赖页面内各模块各自下载自己的日志。
- “日志记录”开启后，日志系统为每次翻译建立 `runId` / `sessionId`，所有相关事件必须能按一次翻译 run 关联。
- 运行时内部事件必须是结构化 JSON，而不是不可解析的自由文本；每条事件至少包含时间戳、等级、分类、来源上下文、消息、可选数据和错误详情。
- 用户默认下载的日志必须是易读 `.log` 文本，格式接近 `[2026-06-27 17:28:22.875][INF][content][run-id][llm.api] module.ts | 消息内容 {"key":"value"}`，便于用户和开发者直接阅读、复制、搜索。
- 可读文本和内部结构化事件必须来自同一批事件，不能形成两套互相不一致的日志。
- 日志必须分类清晰，至少覆盖：
  - `app.config`：关键设置快照、provider、model、processMode、debug 开关，不记录密钥明文。
  - `runtime.message`：content / popup / background 的 runtime message 请求、响应、错误和耗时。
  - `pipeline.stage`：加载、检测、气泡、OCR、排序、翻译、mask refine、inpaint、typeset 等阶段开始/结束/失败。
  - `model.runtime`：模型 session 创建、provider 选择、WebNN/WebGPU/WASM fallback、context lost、worker 运行错误。
  - `pipeline.detect` / `pipeline.ocr` / `pipeline.inpaint` / `pipeline.typeset`：局部 debug 数据摘要和重要失败原因。
  - `llm.api`：provider、auth mode、sanitized endpoint、model、请求开始/结束、HTTP 状态、响应解析、网络错误分类、耗时、请求/响应体摘要。
  - `image.io`：图片下载、截图、blob/base64 转换、content-type、文件大小、失败原因。
  - `chrome.api`：storage、tabs、identity、commands、downloads 等 Chrome API 的 `lastError` 和耗时。
  - `ui.perf`：已有 progress jank / 渲染卡顿报告。
  - `error`：未捕获错误、stage error、可恢复 fallback、最终用户可见错误。
- 针对 DeepSeek / OpenAI-compatible 大模型调用，必须能从日志判断 `Failed to fetch` 的具体上下文：provider、baseUrl、最终 endpoint、是否 content 直连或 background 代理、请求耗时、是否拿到 HTTP 响应、错误 name/message、可能原因标签。
- 日志必须做脱敏：API key、OAuth token、cookie、Authorization header 等秘密永远不能进入导出文件。
- popup 下载的日志包必须能包含最近一次失败 run，即使页面内翻译 UI 已进入 error 状态。
- 现有 typeset debug、OCR debug、translation debug、stage timings、runtime stages、progress jank 应被并入统一日志包，不能保留为平行的散落下载链路。
- 关闭“日志记录”后，不应持续保存详细用户内容日志；现有用户可见错误和普通功能不受影响。
- 日志导出文件名应包含时间戳，扩展名为 `.log`，方便用户发送和开发者归档。
- 用户界面文案使用中文。

## Privacy Decision

- “日志记录”开启后，统一日志包允许包含 OCR 原文、大模型 prompt 和大模型原始响应全文，但必须经过统一脱敏，并对超长文本做截断。
- 统一日志包默认不嵌入原图 data URL，避免日志文件过大并降低图片隐私风险。
- 如果现有 debug artifact 需要引用图片，应优先记录图片元信息、尺寸、content-type、来源 URL 的脱敏版本和处理摘要；确需图片数据时应作为未来单独选项，不属于本次默认行为。

## Acceptance Criteria

- [ ] popup 调试选项中存在单一“下载日志”入口；开启“日志记录”后可导出统一 `.log` 文本诊断日志。
- [ ] 导出的日志按时间排序，行格式为 `[YYYY-MM-DD HH:mm:ss.SSS][LEVEL][context][runId][category] module | message details`。
- [ ] 执行一次本地 pipeline 翻译后，导出的日志包含 config、pipeline stage、model runtime、OCR / detect / inpaint / typeset 摘要、stage timings 和 UI jank 信息。
- [ ] 使用 DeepSeek 或其他 OpenAI-compatible provider 翻译失败时，导出的日志包含 `llm.api` 事件，能区分 HTTP 非 2xx、JSON 解析失败、网络层 `Failed to fetch`、runtime message 失败。
- [ ] 失败 run 也能从 popup 下载到日志，不因 content UI catch 清空单图 `debugLogData` 而丢失。
- [ ] 日志导出不包含 API key、OAuth token、cookie、Authorization 明文。
- [ ] 日志导出默认不包含原图 data URL；OCR 文本、prompt、LLM 原始响应可出现，但必须脱敏并截断超长内容。
- [ ] 原有页面内各块分散“日志下载”逻辑被收口或桥接到统一日志包；不新增第二套并行下载格式。
- [ ] `npm run build` 通过。
- [ ] 至少覆盖日志脱敏、事件 schema 或 LLM fetch 失败分类的单元测试。

## Notes

- 这是复杂任务，规划必须包含 `design.md` 和 `implement.md`，实现前需要用户确认。
- 设计应优先轻量本地方案，不引入远程 telemetry，不上传用户数据。
- 日志系统服务于用户主动导出和开发者排障，不做后台上报。
