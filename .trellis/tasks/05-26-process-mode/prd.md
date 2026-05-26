# PRD: 新增处理模式（翻译模式与去字模式）

## 背景

当前 pipeline 固定走完整流程（检测 → OCR → 翻译 → 去字 → 排版），无法跳过翻译阶段。用户有时只需要去字效果（如修图场景），不需要翻译。此外，去字调试可视化（eraseDebug）当前仍会执行翻译流程，浪费时间和 API 调用。

## 需求

### N1: 新增处理模式设置

在 popup 设置面板中，OCR 引擎 panel 下方新增独立 panel，标题"模式"，包含 radio group：
- **翻译模式**（默认）：当前行为不变
- **去字模式**：跳过翻译和排版，输出 inpaint 后的图片

### N2: pipeline 跳过翻译和排版

去字模式下 pipeline 行为：
- 保留：检测、OCR、bubble detection、merge text lines、match regions to bubbles、reading order、mask refinement、inpaint
- 跳过：翻译、排版
- 最终输出：`cleanedCanvas`（inpaint 后的图片）

### N3: 去字调试可视化改造

`eraseDebug=true` 时一律跳过翻译，不再受模式限制。

### N4: 去字模式 + eraseDebug 的输出

去字模式 + eraseDebug 时，输出 clean canvas + mask 叠加（而非原始图 + mask 叠加），以便同时看到去字效果和 mask 区域的对应关系。

## 设计决策

| 决策 | 结论 |
|------|------|
| 去字模式是否跑 OCR | 保留，mask refinement 依赖 region 信息 |
| bubble detection / merge / match / sort | 全部保留 |
| 跳过的步骤 | 仅翻译和排版 |
| UI 布局 | 独立 panel，标题"模式" |
| 翻译相关设置 | 始终显示 |
| eraseDebug 与模式关系 | 独立，eraseDebug=true 一律跳过翻译 |
| eraseDebug 输出 | 翻译模式：originalCanvas + mask；去字模式：cleanedCanvas + mask |
| 设置字段 | `processMode: 'translate' | 'erase'`，默认 `'translate'` |
| processMode 传入 PipelineConfig | 是 |
| 按钮交互 | 不变，根据 mode 自动切换行为 |
| 完成状态 | 复用 'translated' |
| debug log | 正常收集，翻译字段为空 |

## 验收标准

- [ ] popup 设置面板有独立的"模式"panel，含翻译/去字两个 radio 选项
- [ ] 翻译模式下行为与当前完全一致
- [ ] 去字模式下跳过翻译和排版，输出 inpaint 后的图片
- [ ] eraseDebug=true 时无论什么模式都跳过翻译
- [ ] 去字模式 + eraseDebug 输出 clean canvas + mask 叠加
- [ ] 翻译模式 + eraseDebug 输出 original canvas + mask 叠加（当前行为不变）
- [ ] 去字模式完成后可正常切换原图/结果图
- [ ] 设置持久化，重启插件后 mode 保持
