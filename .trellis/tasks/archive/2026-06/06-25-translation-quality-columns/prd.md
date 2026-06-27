# 优化漫画翻译语序与列间连贯性

## 目标

提升 OCR 文本翻译流程的中文译文质量，重点解决竖排漫画文本在列与列之间读起来不连贯、中文语序残留日语结构、模型逐列直译导致对话不自然的问题。

## 已确认事实

- 当前文本翻译入口在 `src/pipeline/translate.ts`，LLM 批量翻译通过 `llmTranslateRegions()` 一次接收多个文本框。
- 当前 `src/translators/llm.ts` 会为竖排框传入 `sourceText.plainText` 和 `sourceText.columns`，并要求模型返回 `translation` 与 `columns`。
- 当前 prompt 强调 `columns` 按源列顺序返回，但没有明确要求先理解完整语义、改写为自然中文，再重新分列。
- `src/pipeline/textlineMerge/mergePredicates.ts` 对竖排组内文本按右到左排序，`sourceText` 用换行拼接；这适合视觉列顺序，但翻译质量依赖模型能跨列理解语义。
- `src/pipeline/typeset/columns.ts` 在没有可靠模型分列或列过长时会按字数切分，可能把中文短语或标点后的自然停顿切坏。
- 当前 `tests/translators/llm.test.ts` 只覆盖单框请求转发，没有覆盖批量翻译 prompt、结构化输入、JSON 解析和列契约。

## 需求

- LLM 批量翻译必须明确要求“先按完整语义生成自然中文译文，再按视觉排版需要分列”，避免逐列直译。
- 竖排输入必须显式描述阅读顺序、保留换行原文、提供结构化列信息，降低模型误解 `plainText` 与列顺序的概率。
- 横排输入也应沿用同一结构化契约，保持多行框的上下文与行分段信息。
- 单框 fallback 翻译也必须使用更强的漫画本地化 prompt，避免批量失败时质量明显回退。
- 列分段 fallback 应优先在中文自然边界切分，例如标点、语气词、短语边界；只有找不到合适边界时才退回字数硬切。
- 保持运行时兼容：不新增用户配置，不改变 API key、provider、model 配置，不影响 `google_web` 翻译路径。

## 验收标准

- [x] `llmTranslateRegions()` 的请求 payload 包含 `plainText`、保留换行的原文、结构化 `columns` / `lines`、阅读顺序和目标分段数量。
- [x] 批量翻译 prompt 明确要求自然中文语序、允许跨列重组语义、禁止逐列逐词直译，并说明 `columns` 是排版分段而不是逐列直译。
- [x] 单框 `llmTranslate()` prompt 同样强调漫画中文本地化、自然中文语序和只输出译文。
- [x] batch 失败后的 fallback 优先尝试单框结构化翻译，成功时保留 `translatedColumns`。
- [x] 列分段 fallback 在中文标点或自然停顿附近切分，避免优先把短句中间硬切开。
- [x] 新增或更新单元测试覆盖批量 prompt/payload、批量 JSON 解析、单框 prompt、结构化 fallback、语义边界切分。
- [x] `npx tsc --noEmit --pretty false` 通过。
- [x] 相关 Vitest 测试通过，至少覆盖 `tests/translators/llm.test.ts`、`tests/pipeline/translate.test.ts` 和 `tests/pipeline/typeset/columns.test.ts`。

## 非目标

- 不更换 OCR、检测、气泡、inpaint 或 typeset 核心模型。
- 不新增 UI 配置项或模型选择策略。
- 不改 `google_web` 翻译路径的外部服务行为。
- 不把排版层改成基于 LLM 的动态布局引擎。

## 决策

- 第一轮优化直接在现有文本翻译流程内完成，不等待用户补充样例。
- “明显提升”的工程判据是：prompt 和输入契约从逐列翻译倾向改为整句本地化重写，fallback 不再优先硬切中文短语，并用测试锁定这些行为。
