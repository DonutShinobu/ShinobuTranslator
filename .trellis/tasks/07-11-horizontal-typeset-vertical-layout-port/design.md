# 横排复用竖排布局闭环：技术设计

## 1. 设计目标

在不改变翻译、OCR、textline merge 和竖排产品行为的前提下，让横排拥有与竖排对称的基础布局闭环。对称的是职责和控制顺序，不是把竖排公式机械交换 X/Y。

目标数据流：

```text
TextRegion + translated text
  -> horizontal preferred segments
  -> horizontal source geometry profile (optional)
  -> source style / alignment / anchor
  -> per-line safe width profile
  -> pure horizontal layout result
  -> fit policy and fallback
  -> renderHorizontal
  -> composite + debug log
```

## 2. 模块边界

### `sourceGeometry.ts` / `fontFitCore.ts`

- 定义并解析 `HorizontalSourceGeometryProfile`。
- 复用现有有限数值、文字规范化、角度阈值和稳健中位数原则，但保留横排独立的空间顺序判断。
- 全局空间统计与逐行文字映射分离：顺序不可靠时仍可保留安全的全局字号/行距统计，禁用逐行锚点。

建议画像字段：

```typescript
type HorizontalSourceGeometryProfile = {
  lineCount: number;
  groupCenterY: number;
  sourceFontSize: number;
  sourcePitch: number;
  medianPitch: number | null;
  medianGap: number | null;
  medianWidth: number;
  medianHeight: number;
  inferredAlignment: 'left' | 'center' | 'right' | 'unknown';
  perLineCentersY?: number[];
  perLineLeftX?: number[];
  perLineRightX?: number[];
};
```

精确字段名可在实现时按现有类型边界收敛，但必须区分全局安全统计和逐行可信映射。

### `horizontalFit.ts`

- 保存横排专用 fit 类型和 helper，不把竖排 advance/quantization 参数泛化为方向无关参数。
- 提供真实横排行盒度量、对齐画像、逐行安全宽度和 fit 状态判断。
- mask helper 输出某一候选行的连续安全区间，而不只返回一个全局高度。

建议内部契约：

```typescript
type HorizontalLineBox = {
  text: string;
  width: number;
  ascent: number;
  descent: number;
  lineHeight: number;
  baselineY: number;
  x: number;
  maxWidth: number;
  safeInterval?: { left: number; right: number };
};
```

### `horizontalLayout.ts`

- 继续作为横排完整布局编排入口。
- 顺序固定为：输入分段 → 源画像 → 初始样式 → mask 宽度 → reflow → fit → debug geometry。
- 现有 `ColumnBreakReason` / segment ID / segment source 契约继续使用，避免翻译分段来源丢失。
- reflow 使用现有模型分段、现有禁则和现有字符/单词候选。

### `renderHorizontal.ts`

- 改为消费已解析的行盒和 baseline，不在渲染阶段重新计算换行或垂直居中。
- stroke/fill 两遍使用完全相同的 x、baselineY 和字距参数。
- 真实墨迹 padding 在布局阶段计算，渲染阶段不增加隐藏补偿。

### `drawTypeset.ts` / `types.ts`

- 把横排 layout diagnostics 映射到现有 debug log。
- 若扩展共享 debug 类型，字段保持可选，旧日志和 benchmark reader 不得崩溃。
- 诊断只读，不反馈修改 `sourceText`、`translatedColumns` 或布局顺序。

## 3. 源几何解析

### 3.1 全局空间统计

- 过滤 `direction === 'h'` 且中心、宽高有效的源行。
- 空间统计按 `centerY` 从上到下排序。
- `groupCenterY` 从整体上下边缘恢复。
- `sourcePitch` 优先使用相邻行中心差的中位数；单行回退到源字号与正常行高比例。
- `sourceFontSize` 综合可选 `fontSize`、源行高度和源行横向有效单位，避免只用字符数除宽度。

### 3.2 逐行映射

- 首先尝试 `sourceText` 行与几何数组直接匹配。
- 直接匹配失败时，只允许按唯一规范化文本匹配；重复文本或歧义匹配禁用逐行反馈。
- 匹配结果必须保持从上到下单调。
- 空间统计可用但逐行映射失败时，只使用全局字号、pitch 和 group center。

## 4. 源样式与对齐画像

- 横排不实现 `perLineLetterSpacingScale`。所有行共享字号和受限统一字距。
- 计算源行 left/right/center 的离散程度：
  - left 最稳定 -> left；
  - right 最稳定 -> right；
  - center 最稳定 -> center；
  - 差异不足或样本太少 -> unknown，回退当前 center。
- 源行宽度进入布局软约束和诊断，不作为逐行必须命中的硬宽度。
- 源 group center Y 作为整体文字块锚点；只有角度和空间映射可靠时启用。

## 5. 逐行气泡安全宽度

- 根据候选 baseline 和行盒 ascent/descent 得到行的图像 Y 区间。
- 在该区间内扫描 `bubbleMask`，求所有行高像素均可用的横向区间。
- 优先选择包含源 group center X、region center X 或当前对齐锚点的连续区间。
- 为描边和安全边距收缩区间。
- 找不到区间时回退 `contentWidth`，并写入诊断原因。

## 6. 拟合策略

1. 以源画像字号/行距/锚点构建候选；无画像时保留现有初始字号回退。
2. 计算候选行 Y 和逐行安全宽度。
3. 使用现有分段与禁则重新回流，优先消除短尾和超宽。
4. 只允许受限的统一字距调整，不能按行独立缩放。
5. 仍超出高度或安全宽度时，二分寻找最大安全字号。
6. 每个字号候选必须重新计算 line metrics、mask 宽度和换行，不能复用旧字号的行盒。

## 7. 渲染和诊断

- 横排使用 baseline 模型：行高由真实 ascent + descent + leading/fallback 决定。
- Canvas 缺失 actual/font bounding box 时回退到 `measureText().width` 与 font size，不能让布局失败。
- debug box、render placement 和 collision/safe-width calculation 必须使用同一行盒。
- 横排 diagnostics 增加源画像、对齐推断、anchor、逐行 maxWidth/safe interval、fallback reason。

## 8. 兼容性与风险

### 兼容性

- `sourceLineGeometries` 保持可选。
- 旧 debug 字段保持可读；新增字段使用可选类型。
- `src/pipeline/typeset/index.ts` 公共导出不扩张。
- 不修改 vertical orientation 和 vertical render item 契约。

### 主要风险

- mask 坐标与旋转 quad 坐标混用：安全宽度扫描必须明确在图像坐标还是未旋转局部坐标中执行。
- 源行文字重复导致错误逐行匹配：歧义时必须降级。
- 对齐画像在两行短文本上不稳定：需要阈值与 unknown 回退。
- 每次字号候选扫描 mask 可能增加成本：缓存与候选数必须受控，但不能缓存跨字号失效的行盒。
- 横排 helper 与竖排 helper 过度抽象会泄漏方向专用参数：只共享真正方向无关的数值/几何工具。

## 9. 回滚边界

- 源几何画像、mask safe width、line metrics、layout orchestration、render/debug 分阶段实现并分别由测试锁定。
- 任一阶段出现视觉回归时，可关闭该阶段的 profile/option 并回退现有横排路径，不需要回退竖排代码。
- 不删除现有 fallback，直到横排测试和完整门禁均通过。

## 10. 横排重点观察集目录

- `benchmark/typeset/horizontal/` 作为 suite 根目录，包含 `images/`、`fixtures/`、`reports/` 和可选 `baseline.json`。
- `suite-paths.ts` 是所有 typeset benchmark 命令的唯一目录解析入口。
- `--suite-dir` 负责整体切换；`--images-dir`、`--fixtures-dir`、`--reports-dir` 和 bake 的 `--out-dir` 只做局部覆盖。
- 默认配置仍来自 `bench.config.json`，避免破坏历史命令和现有竖排报告。
- benchmark render adapter 按 region 原方向生成源几何，使横排专区真正覆盖横排源画像链路。
- 横排专区使用独立横排数值评分，不复用或扩张竖排专用公式；混排报告分别汇总两个方向。

## 11. Benchmark bake 方向契约

- `shinobuBake(dataUrl, platform, { direction })` 以 `all` 为默认值；`all` 保留 `h | v`，`h`/`v` 只筛选对应方向。
- 方向解析优先使用 merged region 的 `direction`，其次使用 `sourceLineGeometries.direction`，最后按 box 长宽比安全回退。
- pre-merge ground truth 和 merge 后 region 使用同一方向解析，避免横排 region 与错误的竖排检测列关联。
- 浏览器 `bench:bake` 和 Node `bench:bake-node` 共享同一参数 parser 与 fixture adapter，输出在 `bakedWith.direction` 记录筛选值。
- 横排 fixture 的字号估算使用行高与横向 advance，空间顺序按 top-to-bottom；竖排继续使用列宽、纵向 advance 与 right-to-left。

## 12. 横排逐字可视化契约

- `buildHorizontalGlyphPlacements()` 从最终 `HorizontalLineBox`、真实 `measureText()` 字宽和统一 letter spacing 生成每字绘制原点、baseline 与墨迹中心。
- `renderHorizontal()` 的 stroke/fill 两遍和 `drawTypeset()` debug 共用同一份 placement，防止可视化重新估算后与真实渲染漂移。
- 横排中心 Y 使用 `baselineY + (descent - ascent) / 2`，表示真实墨迹盒中心；中心 X 使用当前 pen X 加半个字符宽度。
- 空白字符保留在 placement 中以维持真实 advance，但从 debug 点中过滤。
- `GroundTruthCharCenter.x` 保持可选：新横排 fixture 写入 `{x,y}`，历史竖排 fixture 的 `{y}` 由 overlay 回退到所属列中心。
- offscreen 中心点继续经过 `mapOffscreenPointToCanvas()`，从而与旋转 quad 的合成变换一致。

## 13. Source quad 可视化契约

- `DetectedColumn` 和 `GroundTruthColumn` 增加可选 quad，bake 从 `SourceTextLineGeometry.quad` 原样透传。
- overlay 有 quad 时直接使用四点描边；旧 fixture 无 quad 时继续使用轴对齐矩形，保持历史兼容。
- GT 字符中心使用 quad 中线：横排连接左右边中点，竖排连接上下边中点，按字符中心比例插值。
- `groundTruthColumnToSourceGeometry()` 优先恢复保存的 quad，避免 render adapter 再次把旋转源行降级成矩形。
- 该修复只改变 benchmark 可视化/fixture 几何保真度，不修改 detector、OCR、merge 或产品排版行为。

## 14. 横排数值评分契约

- `RegionMetrics` 按方向区分，竖排旧字段和顶层 `avgCompositeScore` 保持兼容；横排使用独立权重与 `horizontal` summary。
- 横排字符先按 grapheme 去空白并做全文有序匹配，跨行重排不丢字符；换行边界和二维字符距离分开评分。
- 字符距离以实际 fitted font size 归一化，报告 signed X/Y、绝对距离、P95/max 和 `0.5em`/`1em` 离群率。
- 行框使用凸多边形 IoU，文字块使用所有行 quad 的凸包 IoU；缺 quad 允许矩形 fallback，但必须暴露 coverage。
- 逐字诊断单独写入 `horizontal-glyphs.csv`，summary 只保留聚合值，避免 JSON 被逐字记录膨胀。
- baseline 的横排段为可选；旧 baseline 只比较竖排，只有显式更新后的横排段才能开启横排门禁。
