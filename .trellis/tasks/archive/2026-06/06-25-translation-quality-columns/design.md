# 技术设计

## 边界

本任务只修改文本翻译与列分段相关代码：

- `src/translators/llm.ts`
- `src/pipeline/typeset/columns.ts`
- 对应单元测试

不触碰 OCR、merge、inpaint、typeset 渲染几何主体和 popup 配置。

## 数据流

1. OCR 和 merge 阶段生成 `TextRegion.sourceText`，多列文本使用换行表示视觉阅读顺序。
2. `runTranslate()` 将每个 region 转成 LLM 批量输入，包含方向、目标列数/行数和结构化源文本。
3. `llmTranslateRegions()` 发送更明确的 prompt：
   - 模型先理解整页上下文和单框完整语义；
   - 先生成自然中文完整译文；
   - 再按目标列数或行数返回 `columns`；
   - `columns` 是排版分段，不要求逐列对应原文。
4. `parseColumnsPayload()` 读取模型 JSON，继续返回 `translatedText` 和可选 `translatedColumns`。
5. 如果整页 batch 失败或漏掉单个 region，`runTranslate()` 先尝试单框结构化翻译，保留同一 JSON/columns 契约；只有结构化 fallback 也失败时才退回普通单框文本翻译。
6. typeset 列分段优先使用模型列；当需要自动切分时，优先在中文自然边界附近切分。

## 契约变化

### LLM 输入

`sourceText` 从只提供 `plainText` 和对象式 `columns` / `lines`，扩展为：

- `plainText`: 去掉换行后的完整原文。
- `textWithBreaks`: 保留换行的原文。
- `readingOrder`: 竖排为 `right-to-left`，横排为 `top-to-bottom`。
- `columns` / `lines`: `{ index, label, text }` 数组。

该变化只影响发送给 LLM 的 JSON，不影响内部 `TextRegion` 类型和持久化数据。

### LLM 输出

保持既有格式：

```json
{"regions":[{"id":"...","translation":"...","columns":["..."]}]}
```

兼容现有解析、debug 和 typeset 消费方式。

## 列分段策略

`splitByTextLength()` 保留签名不变，但在超过 `maxLength` 时先查找不超过上限的最佳切点：

- 优先中文/日文标点后切分。
- 其次在语气词、连接词等中文自然停顿后切分。
- 找不到合理切点时保留原有按字符长度切分行为。

这样不会改变调用方接口，但能减少 fallback 把中文短语硬切坏的概率。

## 兼容与回滚

- 如果 LLM 不理会新 prompt，解析和 fallback 仍沿用现有机制。
- 如果模型未返回 `columns`，typeset 仍会从 `translation` 换行或文本长度进行分段。
- 如果 batch JSON 失败，单框结构化 fallback 可继续恢复 `translatedColumns`；如果它也失败，普通 fallback 仍保证有译文。
- 回滚点清晰：可单独回退 `llm.ts` prompt/payload 或 `columns.ts` 分段策略。

## 风险

- Prompt 更长，批量翻译 token 消耗略增。
- 某些模型可能对更复杂 schema 的遵循程度不同，需要测试覆盖请求形状和解析路径。
- 语义边界切分是启发式，不能替代模型级自然分列，但比纯字数切分更稳。
