# 竖排字形方向系统实施计划

## Gate

- 当前状态：实现与质量验证完成。
- mixed 策略条件：已确认；句末 `!? / ?! / !! / ??` 双标点纵中横补充条件：已确认。
- 用户审阅条件：已于 2026-07-10 明确批准“开始实现”。
- 剩余产品决策：无。

## Phase A — Lock current behavior and introduce pure orientation logic

1. 为现有 CJK 竖排、源几何步进、分栏、禁则和横排共享 helper 补充回归断言。
2. 新增固定 Unicode 版本的 Vertical Orientation range table 生成脚本与生成物。
3. 实现 grapheme segmentation、UAX #50 lookup 和 project tailoring 纯函数。
4. 为 `~ / 〜 / ～ / ー / — / ― / _ / … / brackets` 建立参数化单测。
5. 为句末 `!? / ?! / !! / ??`、全/半角等价组合和闭合引号场景建立 tokenization 单测，并覆盖单标点、非句末及三连以上标点串的负向场景。
6. 记录生成表的 Unicode 版本、来源 URL、range 数量和 bundle 大小。

**Exit criteria**：纯函数可在不依赖 Canvas 的情况下稳定返回 source、display、orientation 和 reason；旧排版行为尚未切换。

## Phase B — Migrate layout model

1. 引入 `VerticalLayoutItem` 判别联合和 source-range 标识。
2. 在文本进入分栏前完成 grapheme tokenization、句末双标点识别、方向分类及 Latin/digit run 合并。
3. 让列拆分、禁则和 preferred-column 逻辑使用 item，同时继续基于 source grapheme 判定标点语义。
4. 实现 upright、sideways-run、tate-chu-yoko 的测量和 advance 分配。
5. 保留临时 `VerticalGlyph` 适配器，逐步迁移调用点，避免一次性改动难以定位回归。

**Exit criteria**：布局测试可观察正确 item 序列、列归属和 advance；四类句末双标点均在单字符替换前形成一个原子 item；源几何与气泡高度解耦测试通过。

## Phase C — Implement item-aware Canvas rendering

1. 抽取描边/填充共用的 vertical item transform helper。
2. 实现顺时针 90° 的单 glyph 与连续 run 绘制。
3. 实现短数字和句末双标点共用的纵中横测量、缩放和居中，并保留各自 policy。
4. 对 presentation-form 替换增加 bundled font 下的 ink-box 校准。
5. 删除渲染循环中已由 classifier/tailoring 覆盖的特殊字符分支。

**Exit criteria**：专用浏览器 fixture 中描边、填充、中心和方向一致；旧实现的 `︴` 异常与 `ー` 横线可复现地消失。

## Phase D — Finalize run policy and overflow behavior

1. 按用户确认的默认规则实现 Latin/digit run policy。
2. 覆盖 `N`、`ABC`、`AveMujica`、`2026`、`12`、带连字符英文和拉丁/CJK 交界。
3. 覆盖 `真的吗!? / ?! / !! / ??`、对应全角与混合宽度组合、`真的吗?！」`、非句末双标点，以及单标点和三连以上标点串。
4. 实现超长 run 的安全拆分、缩放下限和最终 grapheme fallback。
5. 验证空白处理不会把英文词组无条件粘连，也不会恢复无意义的 OCR 空格。

**Exit criteria**：策略边界全部由表驱动测试表达，fixture 13 的 `AveMujica` 不再无理由跨列拆字，四类句末双标点稳定形成纵中横 item。

## Phase E — Upgrade debug schema and benchmark

1. 为 layout item 输出 versioned debug 字段、方向、旋转角、ink/advance box 和 fallback reason。
2. 更新 overlay，使用不同样式标记 upright、sideways、tate-chu-yoko 及 fallback。
3. 新增竖排字形专用 synthetic fixture 和固定浏览器视觉检查，包含短数字、四类句末双标点及三连负向样例的同框对照。
4. 在评分中增加 `glyphOrientationAccuracy`、`runContinuityRate`、`inkBoxAlignment` 和 `visualFixturePassRate`。
5. 旧 geometry composite 与新 glyph-quality 并列报告；更新报告文案，禁止把单一几何分数称为完整质量分。

**Exit criteria**：旧实现会在新字形指标上明确失败，新实现可定位到具体字符/run 和 reason。

## Phase F — Real-fixture regression and cleanup

1. 严格审计当前 14 张 fixture。
2. 重跑 `bench:render` 与评分，重点人工检查第 7、12、13、14 张 overlay/render。
3. 比较修复前报告 `2026-07-10T07-31-39-778Z`，确认几何指标无显著退化且新增字形指标达标。
4. 删除迁移期旧适配器和失效字符映射，更新相关注释与 benchmark 文档。
5. 运行完整质量门禁并记录结果到任务上下文。

## Planned file areas

| Area | Expected change |
| --- | --- |
| `src/pipeline/typeset/columns.ts` | 将字符替换与方向/禁则职责拆分，迁移列拆分输入 |
| `src/pipeline/typeset/fontFit.ts` | 新 layout item、测量、advance 与 run wrapping |
| `src/pipeline/typeset.ts` | item-aware Canvas transform 与 debug 输出 |
| `src/pipeline/typeset/*orientation*` | Unicode table、grapheme classifier、tailoring/run policy（实际文件名实现时确定） |
| `tests/pipeline/typeset/` | 分类、布局、源几何、横排和渲染契约测试 |
| `benchmark/typeset/src/` | debug schema、overlay、字形指标与报告 |
| `benchmark/fixtures/` | synthetic glyph fixture 与当前真实 fixture 期望值 |

## Verification commands

实现时按由窄到宽的顺序执行；实际新增测试文件名如有调整，以任务记录为准。

```powershell
npx vitest run tests/pipeline/typeset/verticalOrientation.test.ts tests/pipeline/typeset/columns.test.ts tests/pipeline/typeset/fontFit.test.ts
npx tsc --noEmit --pretty false
npm run test
npm run build
npm run bench:audit-fixtures -- --strict
npm run bench:render
npm run bench
```

如新增独立 `bench:vertical-glyphs` 命令，需在 `package.json` 和 benchmark README 中同时记录，并纳入最后质量门禁。

## Review checklist

- [x] Unicode 数据文件版本固定，生成物可重复生成且无运行时网络依赖。
- [x] grapheme/run 在换列前形成，sourceText 与 displayText 未混用。
- [x] 四类句末双标点在单字符标点替换前形成纵中横，单个、非句末及三连以上标点不被误匹配。
- [x] `CJK_H2V` 不再承担方向判断，tailoring 项均有 reason 与测试。
- [x] 描边与填充共享完全相同的 transform。
- [x] source advance、font size、content height、bubble height 继续独立。
- [x] 禁则基于 source grapheme，不受 presentation form 影响。
- [x] 横排与共享 helper 无回归。
- [x] geometry 与 glyph-quality 分别报告，失败可定位。
- [x] 14 张 fixture 的 render、overlay、debug 产物完整。

## Implementation Results

- Unicode 数据：17.0.0，892 个合并 range；生成命令重复运行 SHA-256 保持一致。
- 单测：`34 files / 507 tests` 全部通过。
- 类型与构建：`npx tsc --noEmit --pretty false`、`npm run build` 及 5 个生产 bundle 的 `node --check` 通过。
- Fixture 审计：14 files，114 regions，114 clean/usable，0 rejected。
- Render report：`benchmark/reports/2026-07-10T10-08-43-661Z`，14 张 render/overlay/debug 完整。
- 几何：composite `0.9342`，column IoU `0.8440`，font size error `0.0232`，column count match `100%`。
- 字形：glyph-quality `1.0000`，orientation accuracy `1.0000`，run continuity `1.0000`。
- 相比修复前 `0.9370`，几何 composite 下降 `0.0028`；主要来自 mixed run 与纵中横的已批准几何变化。
- `AveMujica` 使用真实 ink bounds 和中心 offset：30px 字号下旋转 run advance `151px`、列宽 `33px`、inline/cross scale 约 `0.94`，不再被源逐字符 advance 压缩到 `106px`。
- 人工复核：第 7/12 张 wave 方向正确；第 13 张 `AveMujica` 连续、等比旋转且列宽与日文一致；第 14 张 `そうだねーー` 两个 `ー` 均为独立纵线；第 1/4 张 `!? / ！？` 为单格纵中横。
- 第 14 张 `_lll` 保留 OCR 原文并按 mixed 规则输出；未在 typeset 层做语义纠错、重复 Latin 直立或细线描边特判。

## Rollback checkpoints

1. Phase A 只增加纯逻辑和测试，可独立保留。
2. Phase B/C 通过内部适配器切换；严重回归时恢复旧渲染入口，不删除新诊断证据。
3. Phase E 的报告 schema 保持向后读取；回滚产品路径时 glyph-quality 必须显示未启用/失败，而不是伪造通过。
