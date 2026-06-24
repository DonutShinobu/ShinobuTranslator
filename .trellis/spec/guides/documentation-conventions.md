# Trellis 文档语言约定

> 目的：让后续任务文档、规范更新和研究记录默认保持中文，减少跨会话协作时的语言漂移。

## 默认语言

- 新增 Trellis 文档默认使用中文。
- 更新既有 Trellis 文档时，新增内容默认使用中文；如果只是小范围修正英文旧文档，不需要为了语言迁移重写全文。
- 用户明确要求使用其他语言时，以用户当次要求为准。

## 适用范围

该约定适用于 `.trellis/` 下由任务和规范流程生成或维护的文档，包括：

- `.trellis/tasks/**/prd.md`
- `.trellis/tasks/**/design.md`
- `.trellis/tasks/**/implement.md`
- `.trellis/tasks/**/research/*.md`
- `.trellis/spec/**/*.md`
- `.trellis/workspace/**/*.md`

## 保留英文的情况

以下内容可以保留英文或原始命名：

- 文件名、路径、命令、包名、API 名、类型名、函数名、模型名等技术标识。
- 第三方官方名称、官方术语和直接引用。
- 需要与代码、配置或外部文档精确对应的枚举值、参数名和错误码。

## 写作要求

- 标题和正文优先中文。
- 决策、验收标准、风险、回滚点都要写成后续执行者能直接理解的中文。
- 保留必要英文技术词时，尽量在中文句子中解释其作用。
- 不为了翻译而改动代码标识或路径，避免影响检索和实现对照。

## 示例

正确：

```markdown
## 已确认决策

- 主分支 OCR 固定使用 `PP-OCRv6_medium_rec`。
- 新增模型候选前，先更新 `.trellis/spec/frontend/runtime-models.md`。
```

不推荐：

```markdown
## Confirmed Decisions

- Use the medium model.
- Update the model docs first.
```
