# Gemini App 会员额度端到端图片翻译实施计划

## 前置决策

- [x] 确认是否允许在 fallback 中加入 Chrome `"cookies"` permission。
- [x] 确认阅读模式批量在 MVP 中保持禁用 Gemini App 模式。

## 实施步骤

1. 设置与类型
   - [x] 在 `src/types.ts` 增加图片引擎配置字段。
   - [x] 在 `src/shared/config.ts` 增加默认值、归一化、校验和 pipeline 转换边界。
   - [x] 在 `src/shared/messages.ts` 增加 `mt:gemini-app-image-translate` 消息和响应类型。

2. popup UI
   - [x] 新增图片处理引擎切换。
   - [x] 新增 Gemini App 实验开关、提示词模板和风险提示。
   - [x] 仅在实验模式开启时允许选择 Gemini App 引擎。

3. background Gemini App 客户端
   - [x] 新建 `src/background/geminiAppClient.ts`。
   - [x] 实现初始化、上传、生成、解析、下载的最小流程。
   - [x] 固定允许的请求端点，不做通用代理。
   - [x] 实现单飞/队列，确保一次只处理一张图。

4. content script 接入
   - [x] 在 `TranslatorCore` 的 `runPipelineFromFile` 前分支 Gemini App 模式。
   - [x] 普通图片、右键图片、截图浮层复用同一路径。
   - [x] 阅读模式批量遇到 Gemini App 模式时给中文提示并跳过。

5. 错误与调试
   - [x] 增加 Gemini App 错误枚举和中文错误映射。
   - [x] 阶段耗时只记录 stage、duration、非敏感状态。
   - [x] 确保 debug download 不包含 cookie/token/私有请求体。

6. 测试
   - [x] `tests/shared/config.test.ts` 覆盖设置归一化与校验。
   - [x] `tests/shared/messages.test.ts` 覆盖新消息类型守卫。
   - [x] 新增 background Gemini 响应解析纯函数测试。
   - [x] 不新增 content DOM/Chrome mock 测试；按项目测试规范该类集成不强测，改用配置/消息/解析单测、全量测试、构建和产物语法检查覆盖回归风险。

7. 验证
   - [x] `npm run test`
   - [x] `npx tsc --noEmit`
   - [x] `npm run build`

## 回滚点

- 任何协议解析不稳定时，保留设置字段但隐藏 Gemini App 实验入口。
- 如果 cookies fallback 不被接受，保留 browser session 路径并在认证失败时提示无法无感接入。
- 如果生成时间超过 MV3 service worker 可承受范围，回退到后台标签页桥接或要求用户重新确认方案。
