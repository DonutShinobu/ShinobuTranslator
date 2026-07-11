# 横排复用竖排布局闭环

## Goal

把本项目竖排已经验证有效的布局闭环迁移到横排：可靠使用源文字行几何恢复字号、行距、位置和对齐风格，在气泡可用空间内优先重排，最后才缩小字号，并让横排布局、渲染和诊断拥有与竖排对称且可测试的契约。

本任务聚焦两类工作：

1. 可直接复用的竖排能力：源几何可信度与降级、源样式恢复、纯布局结果、字号拟合顺序、真实墨迹边界、两遍渲染和诊断输出。
2. 只能复用思想的能力：把逐列 advance、逐列起始位置、逐列气泡高度和 minor overflow 策略改写成符合横排语义的统一字距、对齐画像、逐行安全宽度和“先重排后缩字”。

## Confirmed Facts

- `TextRegion.sourceLineGeometries` 已包含横排所需的文字、方向、矩形/四边形、中心、宽高和可选字号，不需要修改 OCR 或 textline merge 数据源。
- 竖排已经实现源几何可信度检查、源字号/列距/锚点恢复、逐列气泡空间、二分字号回退、真实 glyph 墨迹 padding 和完整诊断。
- 横排已经有独立的 `computeFullHorizontalTypeset()` 与 `renderHorizontal()`，但当前源几何画像、真实 line metrics、对齐画像和布局诊断不完整。
- 横排当前以固定负字距、固定比例行高、字符/单词贪心换行和行数超限缩字为主。
- `src/pipeline/typeset/index.ts` 必须继续只暴露 `drawTypeset` 和公共类型；新增横排内部契约不得泄漏到 pipeline 其他层。

## Requirements

### R1. 横排源几何画像与可信降级

- 新增横排源几何画像，至少表达源行数、文字块中心 Y、源字号、源行 pitch、源行高度/宽度统计和对齐画像。
- 横排源行必须按从上到下的空间顺序验证；文字顺序与几何顺序无法可靠对应时，只允许使用安全的全局统计，不得使用逐行位置反馈。
- 数量、文本、方向、尺寸或角度不可信时，自动回退到现有无源几何路径，不得重排 `sourceText`、`translatedColumns` 或 benchmark 输入。

### R2. 源样式恢复

- 有可靠源几何时，横排初始字号优先来自源字号画像，而不是只按源行字符数估算。
- 源行 pitch 用于恢复行距，文字块中心 Y 用于恢复整体垂直锚点。
- 根据源行左边缘、右边缘和中心的稳定程度推断左对齐、居中或右对齐；无法可靠推断时保持当前居中回退。
- 源行宽度只作为布局软目标，不得让不同输出行使用不一致的独立字号或激进逐行字距。

### R3. 拟合顺序

- 横排按“保持源样式 → 使用气泡可用空间 → 在现有候选断点内重排/回流 → 小幅统一字距调整 → 最后缩字号”的顺序拟合。
- 不得继续把加强负字距作为解决超行或短尾的主要手段。
- 字号搜索必须同时验证总高度、逐行宽度和目标文字块边界。

### R4. 逐行气泡安全宽度

- 把竖排逐列可用高度思想改写为横排逐行可用宽度：根据候选行的 Y 区间，从 `bubbleMask` 获取包含首选锚点的连续安全横向区间。
- 无 mask、mask 数据无效或无法找到安全区间时，回退到矩形 `contentWidth`。

### R5. 横排行盒与渲染契约

- 横排行盒使用真实 ascent、descent、baseline 和墨迹边界，不再只依赖固定 `0.93em` 高度与 `textBaseline = "top"`。
- 布局结果必须携带渲染所需的行位置和行盒数据；stroke 与 fill 必须消费同一份结果。
- 保留现有四边形旋转合成、统一字体样式和两遍 stroke/fill 行为。

### R6. 诊断和兼容

- 横排诊断至少包含：源几何是否启用、源字号、源 pitch、对齐推断、文字块 Y 锚点、逐行安全宽度、实际字号、行距/字距 scale 和断点来源。
- 诊断、测试或 benchmark 信息不得反馈改写 runtime 输入。
- 竖排的 Unicode orientation、sideways run、纵中横、标点变换、列顺序和逐列 advance 行为不得改变。

### R7. 测试边界

- 为横排源几何、空间顺序、文本匹配、对齐推断、逐行 mask 宽度、baseline 行盒、回退路径和竖排无回归增加纯函数/布局测试。

### R8. 横排重点观察集

- 在 `benchmark/typeset/horizontal/` 建立独立的 images、fixtures、reports 和 baseline 边界。
- typeset benchmark 全链路支持统一 `--suite-dir`，且保持原默认目录和已有细粒度参数兼容。
- 横排 fixture render 必须保留横排源几何方向，不能被 benchmark adapter 写成竖排。
- benchmark bake 默认保留检测到的 `h | v` 区域，并提供 `--direction all|h|v` 让浏览器与 Node bake 使用同一筛选契约。
- 横排可视化必须像竖排一样提供逐字中心点；渲染与 debug 共用真实字宽、字距和 baseline placement，fixture ground truth 提供二维字符中心。
- benchmark bake 必须保留源文字行 quad；GT overlay 优先直接绘制 quad，不能混用 AABB 原点和旋转边长重建横排框。

### R9. 横排数值评分

- 横排与竖排独立评分，现有竖排 `avgCompositeScore`、权重和 baseline 语义不得改变。
- 横排必须量化行 quad、文字块、字号、换行、行距、字符二维中心和 advance，并输出逐字可追踪 CSV。
- 字符按 grapheme 全文有序匹配；跨行重排必须保留字符匹配并由换行与二维距离分别反映。
- 缺少 GT X 时不得伪造字符位置；横排 baseline 只有显式建立后才启用回归门禁。

## Acceptance Criteria

- [x] 可靠的横排 `sourceLineGeometries` 能恢复源字号、行 pitch、文字块中心 Y 和对齐画像。
- [x] 横排源文本顺序与几何顺序不一致、数据缺失或角度不可信时，逐行反馈被禁用且排版稳定回退。
- [x] 同一横排文字块保持统一字号和受限的统一字距，不出现按行独立压缩以追逐源宽度的行为。
- [x] 有气泡 mask 时，每行可以获得不同的安全横向区间；无 mask 时行为回退到矩形内容区。
- [x] 短尾或超行场景先在现有候选断点内重排，再决定是否缩字号。
- [x] 横排按真实 baseline/ascent/descent 布局，stroke/fill 和 debug box 使用同一行盒结果。
- [x] 横排 debug log 包含源几何、锚点、对齐和逐行宽度诊断；诊断不改写 runtime 输入。
- [x] 竖排 orientation、混排 token、源几何、换列、mask、渲染和 benchmark 相关测试无回归。
- [x] `npm run typecheck`、`npm run test`、`npm run build` 通过；最终收口运行 `npm run check`。
- [x] 横排重点观察集已创建，bake、audit、render、bench、diff/baseline 可通过统一 `--suite-dir` 使用。
- [x] 不传 suite 参数时默认 fixture 审计保持兼容；横排 fixture 的源几何方向保持为 `h`。
- [x] 不传 direction 时 bake 保留 `h | v`；显式选择 `h` 或 `v` 时只输出对应方向，并在 fixture 元数据中记录选择。
- [x] 横排 overlay 的每个非空白字符都有独立 GT/实际中心点，且点位来自渲染实际使用的逐字 placement。
- [x] 倾斜横排的 GT 框和字符中心使用原始 source quad；旧 fixture 缺少 quad 时保持矩形回退。
- [x] 横排 region 不再因方向被 skipped，横排与竖排拥有独立综合分和汇总。
- [x] 横排逐字距离、阈值离群率、换行 F1、行 quad/文字块 IoU 和字号/行距指标写入 JSON、Markdown 与 CSV。
- [x] `horizontal-glyphs.csv` 可把每个红绿点匹配回图片、region、字符和二维偏差。
- [x] 旧 baseline 缺少横排段时安全跳过；显式横排 baseline 可启用独立回归门禁。

## Out of Scope

- 修改 LLM 翻译 prompt、`translatedColumns` 语义或 OCR/textline merge。
- 迁移任何竖排专用 orientation、纵中横、标点 presentation form 或 90° run 旋转逻辑。
