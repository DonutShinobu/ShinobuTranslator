# 实施计划

## 步骤

1. 更新 `src/translators/llm.ts`
   - 扩展 `sourceText` payload。
   - 改写批量翻译 system/user prompt。
   - 改写单框 fallback prompt。
   - 保持输出 JSON 格式不变。

2. 更新 `src/pipeline/translate.ts`
   - batch 失败或漏译 region 时优先尝试单框结构化 fallback。
   - 结构化 fallback 失败后再退回普通单框翻译。
   - 保持 translation debug 计数能反映 fallback 请求数。

3. 更新 `src/pipeline/typeset/columns.ts`
   - 在 `splitByTextLength()` 中加入自然边界优先切分。
   - 保留无边界时的原有硬切行为。

4. 更新测试
   - `tests/translators/llm.test.ts` 覆盖批量请求 payload、prompt 关键词和 JSON 解析。
   - `tests/pipeline/translate.test.ts` 覆盖 batch 失败后的结构化 fallback 和普通 fallback。
   - 同文件覆盖单框 prompt 不再是普通“请翻译”。
   - `tests/pipeline/typeset/columns.test.ts` 覆盖标点/语义边界优先切分和原有 fallback。

5. 验证
   - `npx tsc --noEmit --pretty false`
   - `npx vitest run tests/translators/llm.test.ts tests/pipeline/translate.test.ts tests/pipeline/typeset/columns.test.ts`
   - 如失败，修复后重跑。

6. 复核是否需要第二轮
   - 如果测试只能证明 prompt 变化但不能证明列 fallback 改善，继续补充分段测试或实现。
   - 如果发现批量 fallback 仍明显弱，再补结构化单框 fallback。

## 风险文件

- `src/translators/llm.ts`：prompt 和请求 payload 会影响所有 LLM provider。
- `src/pipeline/translate.ts`：fallback 请求顺序和 debug 计数会影响 LLM 失败路径。
- `src/pipeline/typeset/columns.ts`：分段策略会影响竖排和横排 fallback。

## 回滚点

- Prompt/payload 改动可从 `llm.ts` 单独回退。
- 语义切分可从 `splitByTextLength()` 单独回退到原字符计数逻辑。
