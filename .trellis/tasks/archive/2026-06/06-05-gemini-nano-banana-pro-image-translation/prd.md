# Gemini Nano Banana Pro 图片端到端翻译

## Goal

为 ShinobuTranslator 增加一个可选的 Gemini App 会员额度图片端到端翻译模式：用户输入一张漫画/截图后，直接由 Gemini App 的 Nano Banana Pro 完成“识别原文、翻译成中文、擦除原字、重新嵌字”，输出已翻译图片。

## 用户价值

- 给 Google AI Pro / Ultra 用户一个可消耗 Gemini App 会员赠送额度的高质量云端模式，用于绕过本地检测/OCR/翻译/去字/排版链路在复杂图片上的失败点。
- 保留现有本地 pipeline 作为默认、可调试、成本可控的路径。
- 让用户可以在同一个扩展入口里选择“本地分阶段翻译”或“Gemini 端到端图片翻译”。

## 已确认事实

- 当前项目是 Chrome Manifest V3 扩展，popup 使用 React，content script 使用 imperative DOM。
- 设置通过 `src/shared/config.ts` 的 `ExtensionSettings` 归一化并经 Chrome runtime message 保存到 `storage.local`。
- 当前翻译入口在 content script 中下载/截图为 `File`，懒加载 `src/pipeline/orchestrator.ts` 的 `runPipeline()`，最终把 `PipelineArtifacts.resultCanvas` 转为 blob URL 替换或展示图片。
- 当前文本 LLM 翻译只发生在 `src/pipeline/translate.ts`，大模型配置在 popup 的“服务=大模型”下；OpenAI OAuth 是专用通道，后台 service worker 负责 token 存储、刷新和代理请求。
- Gemini App 官方帮助页确认：用户可以在 `gemini.google.com` 上传图片并让 Gemini 编辑图片。
- Gemini App 官方帮助页确认：Nano Banana Pro 是 Gemini 3 的高级图片生成/编辑模型；达到 Gemini 3 Pro 日额度后，直到重置前不能继续使用 Nano Banana Pro。
- Gemini App limits 官方帮助页列出 Nano Banana Pro 日额度：无 Google AI 计划最多 3 张/天，Google AI Pro 最多 100 张/天，Google AI Ultra 最多 1000 张/天；额度可能频繁变化并每日重置。
- 官方 Gemini API 的图片生成/编辑文档把 Nano Banana Pro 对应为 `gemini-3-pro-image`，支持 text-and-image-to-image，响应里返回 `inlineData` 图片，但该路径消耗 Gemini API / Google Cloud 项目额度，不满足本任务硬性要求。
- 官方 Gemini API quickstart 要求 API key；OAuth 文档也是面向 Google Cloud 项目和 OAuth 客户端，而不是直接复用 Gemini App 会员额度。
- 官方 Gemini Developer API pricing 对 `gemini-3-pro-image` 标注 Free Tier 不可用，Paid Tier 才可用；这进一步确认 API Key 路径不是 Gemini App 会员额度路径。
- Google Terms of Service 禁止滥用、干扰、绕过保护措施，禁止 reverse engineering 服务或底层技术以提取商业秘密/专有信息，并限制违反机器可读指令的自动化访问。设计需要避开 Cookie 复制、私有接口逆向和安全/额度保护绕过。

## 当前推荐边界

- 用户已明确拒绝官方 API Key / Paid Tier 方案；“必须使用 Gemini App 会员赠送额度”是硬性需求。
- 用户已明确拒绝可见 Gemini App 网页桥接；“用户无感”是新增硬性体验要求。
- 用户要求调研 GitHub 开源项目，优先复用现成 Gemini Web / Gemini App 非官方实现。
- 用户确认该功能是个人实验性质，不作为商业产品能力发布；接受非官方 Gemini Web 协议带来的脆弱性和失效风险。
- 用户允许将 Chrome `"cookies"` 权限作为认证 fallback 加入扩展，但仅限 Gemini App 实验模式使用。
- 用户确认 MVP 先禁用阅读模式批量 Gemini App 翻译。
- 当前实现方向是 TypeScript background 最小协议移植：参考开源 Gemini Web 非官方实现，对固定 Gemini/App 上传与生成端点发起请求，尽量复用本机 Chrome 登录态。
- 完全官方、稳定、无页面、无标签、纯后台地消耗 Gemini App 会员额度没有已知公开接口；本任务作为个人实验功能接受非官方协议的脆弱性。
- 实验功能必须是用户本机、用户已登录、显式启用；不持久化 Google 账号 Cookie，不复制认证令牌到设置或日志，不尝试绕过安全/额度限制。
- Gemini Web 私有协议、请求字段、模型头、生成响应结构和下载 URL 都可能变化；需要清晰失败提示和禁用/回退路径。
- 官方 API Key / Paid Tier 可作为未来可选 fallback，但不是本任务 MVP。
- 新模式应作为独立图片翻译引擎，不塞进现有 `translator: 'google_web' | 'llm'` 文本翻译枚举；它应绕过本地 OCR/翻译/去字/排版阶段，直接返回结果图片。

## Requirements

- 用户可以在 popup 中选择图片处理引擎：现有本地 pipeline 或 Gemini App 端到端图片翻译。
- 用户可以配置 Gemini App 实验选项：是否启用、认证策略、翻译提示词模板。
- 当选择 Gemini App 端到端模式时，扩展在点击翻译、截图翻译、右键图片翻译入口中使用同一套云端图片翻译路径。
- 阅读模式批量翻译 MVP 禁用 Gemini App 模式，避免意外快速消耗会员额度；未来若要支持批量，需要显式限速和用户确认。
- Gemini App 实验模式必须通过 background 的固定消息和固定端点执行，不提供任意 URL 代理；MVP 不应打开或抢占 Gemini 页面，除非需要用户登录、授权或手动恢复失败状态。
- Gemini App 端到端模式失败时给出中文错误信息；如果没有返回图片，明确提示 Gemini App 未返回可用译图，并尽量保留原图。
- 如果 Gemini App 提示未登录、额度耗尽、地区/年龄/账号不支持或模型不可用，错误信息必须直接反映该状态。
- 保留现有本地 pipeline 和 LLM 文本翻译行为不变。

## Acceptance Criteria

- [ ] popup 可切换“本地 pipeline / Gemini App 端到端”图片处理引擎，并保存设置。
- [ ] Gemini App 模式未启用或用户未确认风险时，启动翻译前显示中文校验错误，不打开 Gemini 页面。
- [ ] background 能通过固定 `mt:gemini-app-image-translate` 消息接收图片，并拒绝未开启实验模式的调用。
- [ ] background 能使用本机 Chrome 登录态或允许的 `"cookies"` fallback 上传图片、提交生成请求并等待结果。
- [ ] background 能提取或下载第一张生成图片，返回 base64、MIME type、阶段耗时/基本元数据。
- [ ] content script 能用 Gemini App 返回图片生成 blob URL，并在普通图片、右键图片、截图浮层中展示；阅读模式批量明确拒绝 Gemini App 模式。
- [ ] 现有本地模式、Google Web 翻译、LLM 文本翻译、OpenAI OAuth 行为保持兼容。
- [ ] 新增/更新单元测试覆盖设置归一化、消息类型校验、Gemini 桥接状态解析、未启用/未登录/额度耗尽错误映射。
- [ ] `npm run build` 和相关 Vitest 测试通过。

## Out of Scope

- 将 Gemini Web 私有协议包装为远程服务、共享代理或商业化稳定 API。
- 复制、导出或持久化 Google 账号 Cookie、OAuth token、内部 session token。
- 绕过 Gemini App 的安全过滤、额度限制、地区/年龄/账号限制。
- 自动购买、管理或查询 Google AI 订阅。
- 对 Gemini 生成结果做本地 OCR 质量评估或自动修复排版。
- 大规模无人值守批量消耗 Gemini App 额度。

## 外部依据

- Google AI for Developers: Image generation with Gemini, `gemini-3-pro-image` / Nano Banana Pro, text-and-image-to-image, `inlineData` 输出；这是 API 方案的参考，但不是本任务 MVP。
- Google AI for Developers: Gemini API quickstart, API key 是默认认证方式；这是为什么 API 方案不能消费 App 会员额度的依据。
- Google AI for Developers: Gemini Developer API pricing, `gemini-3-pro-image` Free Tier 不可用、Paid Tier 可用。
- Gemini Apps Help: Generate & edit images with Gemini Apps，确认 Gemini App 支持上传图片并用 Nano Banana / Nano Banana Pro 编辑。
- Gemini Apps Help: Gemini Apps limits and upgrades for Google AI subscribers，确认 App 侧 Nano Banana Pro 日额度和可变限制。
- Google Terms of Service / Generative AI Prohibited Use Policy，用于约束不要逆向、绕过保护或滥用服务。

## GitHub 调研记录

- `HanaokaYuzu/Gemini-API` / PyPI `gemini_webapi`：反向封装 Gemini Web App，README 明确要求 `__Secure-1PSID` / `__Secure-1PSIDTS` cookie 或通过 `browser-cookie3` 从本机浏览器自动导入；支持 Gemini Web 图片生成/编辑和保存生成图。技术上最接近“会员额度 + 图片生成/编辑”，但不适合直接嵌入 MV3 扩展，也触及 cookie 复用和私有 Web API。
- `dsdanielpark/Gemini-API` / `python-gemini-api`：通过 cookie 调 Gemini Web，支持图片输入和生成图片；README 明确要求导出 Gemini cookies、必要时复制 `StreamGenerate` 请求的 `at` nonce。技术上命中“无官方 API key”，但依赖 cookie/nonce 和私有接口。
- `Sophomoresty/gemini-web2api`：把 Gemini Web 转成 OpenAI-compatible API；README 明确 Pro 路由需要 Gemini Advanced 账号 cookie，且可能需要 XSRF token、`auth_user`、`gemini_bl`。更像本地/服务器代理，不适合直接作为扩展内置依赖。
- `OEvortex/Gemini-Chat-API`：通过 `__Secure-1PSID` / `__Secure-1PSIDTS` cookie 访问 Gemini，支持带图片提问和处理图片响应；仍然是 cookie 方案。
- `asabya/gemini-webapi-unofficial-openai-api`：基于 `gemini-webapi` 的 FastAPI 代理，README 明确依赖浏览器 session cookie，且注明适合个人/开发用途、不适合稳定生产。
- `GeminiGenAI/Free-Nano-Banana-Pro-API-Ultimate-AI-Image-Generator`：README 指向第三方 `geminigen.ai` 平台和 API 文档，不是复用用户 Gemini App 会员额度；不满足硬性需求。

## 调研结论

- GitHub 上确实存在现成非官方 Gemini Web/App 项目，且有项目支持图片生成/编辑。
- 找到的“用户无感 + 消耗 App 会员额度”路线本质上都依赖 Google/Gemini cookies、XSRF/nonce 或 Gemini Web 私有接口；没有发现官方支持、可稳定嵌入 Chrome MV3 扩展、且无需可见/后台 Gemini 页面参与的开源方案。
- 若坚持复用这些项目，需要引入本地 companion service 或把 Python/私有协议移植到 TypeScript background；这会把 Google session cookie/内部 token 变成扩展处理的数据，超出当前安全边界。
- 在用户确认实验性质后，规划可以继续评估 TypeScript background 移植方案，但必须保留明确的失败提示、低频调用限制、日志脱敏和一键关闭。

## 若仅按浏览器插件适配性排序

1. `HanaokaYuzu/Gemini-API` 的协议路线最适合作为技术参考：它已覆盖 Gemini Web 初始化、账号状态、模型发现、文件上传、图片生成/编辑、生成图片下载和 cookie 刷新，是唯一同时命中“会员额度”和“图片编辑/生成”的完整候选。
2. 对 Chrome MV3 扩展来说，最贴近插件形态的改造不是直接运行 Python 包，而是把其最小 RPC 流程改写成 TypeScript background service：由扩展 background 对固定的 `gemini.google.com` / Google upload 端点发请求，使用浏览器已有登录态，不把 cookie 值写入扩展设置或调试日志。
3. `OEvortex/Gemini-Chat-API` 的 `gemini.js` 是 JavaScript，但能力过旧，主要是 `StreamGenerate` 文本聊天和图片 URL 提取，不覆盖当前需要的图片上传、Nano Banana Pro 图片编辑和生成图下载。
4. `Sophomoresty/gemini-web2api` 适合本地 OpenAI-compatible 文本代理，但 README 明确不支持图片/多模态输入，因为 Gemini 图片上传依赖专有 streaming RPC；不适合作为本功能基底。
5. 第三方“Free Nano Banana Pro API”类项目不使用用户 Gemini App 会员额度，排除。

## 最小可行技术形态（风险接受前提下）

- popup 只负责开关和提示词模板，不收集 Google cookie。
- content script 仍负责从页面取图/截图并把 `File` 交给 background。
- background 只暴露一个固定的 `mt:gemini-app-image-translate` 消息，不接受任意 URL 代理请求。
- background 按 `HanaokaYuzu/Gemini-API` 的最小流程发起 Gemini Web 初始化、图片上传、生成请求、结果图下载，并把图片 bytes 返回给 content script。
- 该路线仍然是私有 Gemini Web 协议移植；若进入实现，需要把“账号/额度/页面变更/认证失效/地区限制”都当成正常失败场景。

## 实验约束

- 默认关闭，用户需要在 popup 中显式开启实验模式。
- 仅面向当前本机 Chrome 登录账号使用，不提供远程服务或共享代理。
- 默认串行执行，一次只处理一张图；阅读模式批量入口默认禁用 Gemini App 模式。
- 不记录、导出或展示 Google cookie、XSRF token、内部请求载荷中的敏感字段。
- 如启用 `"cookies"` fallback，仅读取固定 Gemini/Google cookie 名称，内存使用，不持久化到设置、日志或调试导出。
- 失败时回退为原图和中文错误提示，不自动重试大量请求。

## Open Questions

- 当前前置决策已完成；实现阶段如发现 Chrome 无法通过 background fetch 携带或拼接可用登录态，需要重新评估本地 companion service 或后台标签页桥接。
