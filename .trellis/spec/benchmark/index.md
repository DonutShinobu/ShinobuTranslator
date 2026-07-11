# Benchmark Development Guidelines

> 测试框架和基准测试的开发指南。

---

## Overview

项目在 `benchmark/` 下有三类基础设施：

1. **排版基准** — `benchmark/typeset/`，fixture bake、render、几何/字形指标与回归报告。
2. **颜色诊断** — `benchmark/color/`，文字前景/背景色取样的诊断和量化对比。
3. **Pipeline 性能与 smoke** — `benchmark/perf/`，包括 Node OCR、真实 Chromium/WebGPU OCR/pipeline/UI jank smoke 和单路径 Paddle profile。

Node 脚本通过 `tsx` 和 `canvas` 运行；浏览器脚本通过 Playwright 启动 Chromium，并加载独立 `benchmark.html`。历史 JSON/Markdown 可以保留，但旧报告中的命令或 runtime 名称不构成当前可执行入口。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Color Diagnostic Guide](./color-diagnostic-guide.md) | 颜色识别算法诊断与对比框架使用说明 | Filled |

---

## Key Architecture Facts

- **Node 与浏览器分离** — typeset/color/Node OCR 直接由 `tsx` 运行；浏览器 smoke/profile 由 Playwright 加载 benchmark build
- **独立 browser entry** — `benchmark.html` → `src/benchmark/browserEntry.ts` → `window.__shinobuBenchmark__`，只在 `vite build --mode benchmark` 中存在
- **Release 隔离** — `npm run build` 不包含 benchmark entry/global；`npm run build:benchmark` 先完成 Release build/断言，再生成 benchmark 页面
- **运行方式** — 优先使用 `package.json` 中的具名 npm scripts，不为已删除 runtime 保留兼容命令
- **bake-node** — `npx tsx benchmark/typeset/src/bake-node.ts [--out-dir path] [image1.png ...]` 或 `npm run bench:bake-node`，使用 `nodePlatform` + `onnxNodeBridge`（CUDA EP），输出 Fixture JSON
- **bake-node 字体限制** — node-canvas 的 `registerFont()` 只支持 `.ttf/.otf/.ttc`，不支持 `.woff2`。若项目字体只有 `.woff2` 格式，需安装系统 CJK 字体作为 fallback
- **Fixture 数据** — JSON 注解文件 git 追踪，实际图片文件 gitignore（用户手动添加）
- **报告输出** — 新生成的 `benchmark/reports/`、`benchmark/perf/reports/` 默认忽略；已经追踪的历史报告只读保留
- **排版观察集目录** — typeset benchmark 命令统一支持 `--suite-dir <root>`；目录自动映射为 `<root>/images`、`<root>/fixtures`、`<root>/reports` 和 `<root>/baseline.json`
- **颜色工具函数** — `color-utils.ts` 从 `src/pipeline/typeset/color.ts` 重新导出 `rgbToLab`/`colorDistance`/`resolveColors`，不直接引用浏览器端代码（避免 ONNX Runtime 等浏览器依赖）

---

## Pre-Development Checklist

Before modifying benchmark scripts, verify:

- [ ] `tsx` 可用（`package.json` devDependencies）
- [ ] `canvas` 已安装（Node.js Canvas/DOM 适配）
- [ ] Fixture 注解格式与 `color-types.ts` 中的类型定义一致
- [ ] benchmark 只测量/适配生产能力；如实验需要改 `src/pipeline/`，必须在独立 Trellis 实现任务中说明产品影响
- [ ] 重复逻辑提取到 `color-utils.ts`（共享工具优于各脚本内复制）
- [ ] 颜色算法脚本放在 `benchmark/color/src/`，排版脚本放在 `benchmark/typeset/src/`
- [ ] 浏览器 API 只从 `src/benchmark/browserEntry.ts` 暴露，Release 产物断言保持通过

---

## 场景：Typeset Benchmark Suite 目录契约

### 1. Scope / Trigger

- 触发：新增独立排版观察集，或修改 `bake-fixtures.ts`、`bake-node.ts`、`audit-fixtures.ts`、`render-result.ts`、`run-bench.ts`、`diff-baseline.ts` 的目录解析。
- 目标：同一观察集的图片、fixture、报告和 baseline 始终使用同一个根目录，不因某条命令遗漏参数而混入默认竖排数据。

### 2. Signatures

```bash
npm run bench:bake -- --suite-dir <root> [--direction all|h|v]
npm run bench:bake-node -- --suite-dir <root> [--direction all|h|v] [image...]
npm run bench:audit-fixtures -- --suite-dir <root> [--strict]
npm run bench:render -- --suite-dir <root>
npm run bench -- --suite-dir <root>
npm run bench:diff -- --suite-dir <root>
npm run bench:baseline -- --suite-dir <root>
```

所有命令同时支持细粒度覆盖：`--images-dir`、`--fixtures-dir`、`--reports-dir`。两个 bake 命令继续把 `--out-dir` 作为 `--fixtures-dir` 的兼容别名。

```typescript
type BakeDirection = "all" | "h" | "v";

type ShinobuBakeOptions = {
  direction?: BakeDirection;
};

type BakeResultRegion = {
  direction: "h" | "v";
  // ...
};

type GroundTruthCharCenter = {
  x?: number;
  y: number;
};

type GroundTruthColumn = {
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  // legacy axis-aligned geometry remains available
};

type HorizontalGlyphPlacement = {
  ch: string;
  x: number;
  baselineY: number;
  centerX: number;
  centerY: number;
  width: number;
};
```

### 3. Contracts

- `--suite-dir <root>` 映射：
  - images：`<root>/images`
  - fixtures：`<root>/fixtures`
  - reports：`<root>/reports`
  - baseline：`<root>/baseline.json`
- 未传 `--suite-dir` 时，继续读取 `bench.config.json` 的默认 `imagesDir`、`fixturesDir`、`reportsDir` 和原 `benchmark/typeset/baseline.json`，旧命令行为不变。
- `--images-dir`、`--fixtures-dir`、`--reports-dir` 的显式值优先于 suite 自动映射；相对路径统一相对仓库根目录解析。
- 路径解析只由 `suite-paths.ts` 负责，所有命令消费同一结果，禁止各脚本重新维护一套硬编码常量。
- fixture render 必须把 `region.direction` 原样写入 `sourceLineGeometries.direction`；横排观察集不能被 adapter 硬编码为 `v`。
- 两个 bake 入口的 `--direction` 语义必须一致：`all` 同时保留 `h | v`，`h`/`v` 只保留对应方向；未传参数时默认 `all`。
- `shinobuBake()` 必须按 region/source geometry/box fallback 解析真实方向，并在 `BakeResultRegion.direction` 保留 `h | v`，不得把输出硬编码为 `v`。
- fixture 的 `bakedWith.direction` 必须记录本次选择；旧 fixture 缺少该字段时仍可读取。
- 横排 ground truth 按从上到下验证空间顺序，竖排 ground truth 按从右到左验证；方向选择不能改变各自的空间语义。
- 横排 renderer 与 debug 必须消费同一份 `HorizontalGlyphPlacement[][]`；逐字 `x` advance、baseline 和中心点不得在 overlay 中重新估算。
- 横排实际字符中心使用真实字宽与统一 letter spacing：`centerX = penX + width / 2`，`centerY = baselineY + (descent - ascent) / 2`。
- 横排 fixture ground truth 的 `charCenters` 必须写入 `{x,y}`；旧竖排 fixture 的 `{y}` 保持兼容，overlay 仅在 `x` 缺失时回退 `column.centerX`。
- bake 必须把每条 `SourceTextLineGeometry.quad` 原样传到 `DetectedColumn.quad` 和 `GroundTruthColumn.quad`；不得在 fixture 边界丢弃旋转几何。
- GT overlay 有 quad 时必须直接描四边形；只有旧 fixture 缺少 quad 时才用 `centerX/topY/width/height` 画轴对齐矩形。
- 有 quad 的 GT 字符中心沿文字行中线插值：横排从左边中点到右边中点，竖排从上边中点到下边中点。
- 空白字符参与渲染 advance，但不输出可视化点；诊断点不能改变渲染文本或断行。
- `run-bench.ts` 必须按 `direction` 分别计算横竖指标；横排有可用二维字符对时不得再仅因方向标记为 skipped。

### 4. Validation & Error Matrix

| 条件 | 必须行为 |
| --- | --- |
| `--suite-dir` 或细粒度目录参数缺值 | 立即报 `<option> requires a path.`，不得退回默认目录 |
| suite 的 `images/` 为空 | bake 明确报告该目录没有图片，不运行 pipeline |
| suite 的 `fixtures/` 为空 | audit/render/bench 明确报告没有 fixture，不读取默认 fixture |
| suite 的 `reports/` 没有 summary | diff 明确报告没有 report，不读取默认 baseline/report |
| 出现未知参数 | 非 bake-node 图片位置参数时立即失败 |
| 同时传 suite 和细粒度目录 | 只覆盖指定子目录，其余仍来自 suite |
| `--direction` 缺值 | 立即报 `--direction requires a value: all, h, or v.` |
| `--direction` 不是 `all|h|v` | 立即报告允许值和收到的值，不运行 pipeline |
| 未传 `--direction` | 使用 `all`，保留检测到的所有 `h | v` 区域 |
| 选择 `h` 或 `v` 后无匹配区域 | 正常生成空 regions fixture，不回退到另一方向 |
| 旧 fixture 的字符中心没有 `x` | overlay 使用所属列的 `centerX`，不得拒绝旧 fixture |
| 横排行为空或只含空白 | 不输出字符点，渲染/审计不崩溃 |
| 横排存在旋转 quad | 逐字中心通过现有 offscreen-to-canvas transform 映射，不直接使用未变换局部坐标 |
| 新 fixture 的 source line 有 quad | 完整 round-trip 到 GT column 和 render source geometry |
| 旧 fixture 缺少 GT quad | 保持矩形框与旧字符中心回退，不拒绝、不猜旋转角 |

### 5. Good / Base / Bad Cases

- Good：`npm run bench:render -- --suite-dir benchmark/typeset/horizontal` 只读取横排专区并把报告写回该专区。
- Base：不传 suite 参数，六条命令继续使用 `bench.config.json` 中的原目录。
- Good：bake 临时 fixture 使用 `--suite-dir ... --out-dir benchmark/reports/candidate-fixtures`，图片仍来自 suite，fixture 输出使用显式目录。
- Good：`--direction h` 生成的 fixture 只含横排区域，且 `bakedWith.direction === "h"`。
- Base：不传 `--direction` 等同于 `--direction all`，混排图片中的横排和竖排区域都被保留。
- Good：横排 overlay 中每个非空白字符都有独立的绿色 GT 点和红色实际点，点位沿行内 advance 递增。
- Good：倾斜横排的绿色框直接贴合原始 detector quad，绿色字符点沿倾斜中线分布。
- Base：历史竖排 fixture 只有 `{y}` 字符中心，overlay 仍按原列中心绘制。
- Bad：使用 AABB 的 `topY` 配合旋转 quad 的 intrinsic `height` 重建矩形；长横排会显示成过矮绿框。
- Bad：只给 bake 改目录，render/bench 仍硬编码 `benchmark/typeset/fixtures`，导致观察集串数据。
- Bad：横排 fixture 在 render adapter 中生成 `direction: "v"` 的源几何，使横排源画像静默降级。
- Bad：benchmark bake 在 merge 前后使用 `.filter(region.direction === "v")`，导致浏览器插件能识别的横排区域在 fixture 中消失。

### 6. Tests Required

- `tests/benchmark/suite-paths.test.ts`：默认目录、suite 展开、细粒度覆盖、`--out-dir` 兼容和缺值错误。
- `tests/benchmark/fixture-render.test.ts`：横排 region 生成的 `sourceLineGeometries.direction === "h"`。
- `tests/benchmark/bake-options.test.ts`：默认 `all`、空格/等号两种参数形式、缺值与非法值。
- `tests/benchmark/fixture-build.test.ts`：横排/竖排 fixture 均保留方向，并使用各自的字号和空间几何语义。
- `tests/benchmark/source-geometry.test.ts`：横排从上到下、竖排从右到左的空间顺序审计。
- `tests/pipeline/typeset/renderHorizontal.test.ts`：逐字 placement 使用真实宽度/letter spacing，并被 stroke/fill 两遍共同消费。
- `tests/pipeline/typeset/drawTypeset.test.ts`：横排 debug 输出逐字中心，行内 x 单调递增且同一行 y 一致。
- `tests/benchmark/fixture-build.test.ts`：横排 ground truth/current snapshot 输出二维字符中心，竖排旧行为不变。
- `tests/benchmark/fixture-build.test.ts`：旋转 source quad 在 fixture 中保留，横排字符中心沿左右边中点连线插值。
- `tests/benchmark/fixture-render.test.ts`：GT quad round-trip 回 `SourceTextLineGeometry`，旧无 quad 输入仍生成矩形 fallback。
- 空 suite 命令 smoke：bake/audit/render/bench/diff 的错误路径必须显示所选 suite 子目录。
- 真实 bake smoke：同一批图片至少验证一次 `--direction all` 和一次单方向选择，并对输出运行 strict fixture audit。
- 默认回归：`npm run bench:audit-fixtures -- --strict` 仍审计正式默认 fixture。
- 完整门禁：`npm run check` 和 `git diff --check`。

### 7. Wrong vs Correct

#### Wrong

```typescript
const FIXTURES_DIR = join(ROOT, "benchmark/typeset/fixtures");
const REPORTS_DIR = join(ROOT, "benchmark/reports");
```

每条命令单独硬编码目录会让新增观察集只在部分阶段生效。

#### Correct

```typescript
const parsed = parseTypesetSuiteArgs(process.argv.slice(2));
const { imagesDir, fixturesDir, reportsDir } = parsed.paths;
```

统一解析保证 bake、render、评分和 baseline 处于同一 suite 边界。

#### Wrong: bake 方向硬编码

```typescript
const regions = mergedRegions.filter((region) => region.direction === "v");
return regions.map((region) => ({ ...region, direction: "v" as const }));
```

#### Correct: 方向是可选契约

```typescript
const selectedDirection = options.direction ?? "all";
const regions = mergedRegions.filter((region) => (
  selectedDirection === "all" || resolveBakeRegionDirection(region) === selectedDirection
));
```

#### Wrong: overlay 重新估算横排点位

```typescript
const x = line.x + index * averageGlyphWidth;
```

#### Correct: 渲染与诊断消费同一份 placement

```typescript
const placements = buildHorizontalGlyphPlacements(ctx, lineBoxes, letterSpacing);
renderHorizontal(lineBoxes, fontSize, width, height, colors, padding, font, scale, platform, placements);
const centers = placements.map((line) => line.map((glyph) => ({
  ch: glyph.ch,
  x: glyph.centerX,
  y: glyph.centerY,
})));
```

#### Wrong: 混合 AABB 与旋转边长重建 GT 框

```typescript
ctx.strokeRect(column.centerX - column.width / 2, column.topY, column.width, column.height);
```

#### Correct: 优先保留并绘制原始 quad

```typescript
if (column.quad) {
  drawQuad(ctx, column.quad);
  ctx.stroke();
} else {
  drawLegacyGroundTruthRect(ctx, column);
}
```

---

## 场景：横排数值评分与 baseline 契约

### 1. Scope / Trigger

- 触发：修改 `horizontal-metrics.ts`、`horizontal-summary.ts`、`run-bench.ts`、`diff-baseline.ts` 或 typeset 报告类型。
- 目标：红绿字符点、旋转行框、换行和行距偏差能被方向专用指标量化，同时保持竖排历史分数与 baseline 语义不变。

### 2. Signatures

```typescript
type RegionMetrics = VerticalRegionMetrics | HorizontalRegionMetrics | SkippedRegionMetrics;

type HorizontalMetricComputation = {
  metrics?: HorizontalMetricValues;
  skipReason?: "no_horizontal_lines" | "no_horizontal_glyph_pairs";
  glyphDiagnostics: HorizontalGlyphDiagnostic[];
};

type BenchmarkSummary = {
  schemaVersion: 2;
  avgCompositeScore: number; // 兼容字段，仍只表示竖排
  horizontal: HorizontalBenchmarkSummary;
};
```

- `bench.config.json.horizontalScoreWeights` 固定包含 `lineCountMatch`、`lineQuadIouMean`、`blockHullIou`、`fontSizeError`、`lineBreakF1`、`glyphPositionCoverage`、`charCenterQuality`，权重和为 1。
- 报告新增 `horizontal-glyphs.csv`；每行包含图片、region、匹配状态、字符、GT/预测索引与坐标、`dxNorm`、`dyNorm`、`distanceNorm`。

### 3. Contracts

- 竖排继续使用原 `computeRegionMetrics()`、原 `ScoreWeights` 和顶层 `avgCompositeScore`；横排综合分只写入 `BenchmarkSummary.horizontal.avgCompositeScore`。
- 横排 GT/预测字符按 grapheme 分段并过滤空白；全文完全一致时逐字匹配，否则使用保持顺序、近邻 tie-break 的字符对齐，禁止按长度比例猜配。
- 字符和行中心距离优先除以实际 `fittedFontSize`；无效时回退 GT 中位字号，再回退 1。
- 横排行 IoU 使用真实旋转 quad 的凸多边形交并比；缺 quad 时仅该行回退 AABB，并通过 `sourceQuadCoverage` 暴露标注覆盖率。
- 横排 GT 没有可用 X 坐标时不得回退 `column.centerX` 参与数值评分；没有任何二维字符对的 region 使用 `no_horizontal_glyph_pairs` 跳过。
- Markdown、JSON 和 per-region CSV 必须分开表达横竖指标；横排最差 region 按字符距离 P95 排名。
- baseline 没有 `horizontal` 段时只比较竖排并明确跳过横排；baseline 有横排段但当前横排可评分数为 0 时必须失败。

### 4. Validation & Error Matrix

| 条件 | 必须行为 |
| --- | --- |
| GT 或预测没有横排行 | region skipped，reason=`no_horizontal_lines` |
| 文本可匹配但 GT 字符没有 X | region skipped，reason=`no_horizontal_glyph_pairs`，不得伪造 X |
| 文本跨行重排 | 全文字符仍匹配；`lineBreakF1` 和真实二维距离分别反映换行与位移 |
| GT/预测字符增删 | 只匹配同字符有序子序列，覆盖率下降，未匹配项写入逐字 CSV |
| 旧 baseline 缺少 horizontal | 横排回归检查跳过，不产生 NaN 或误报 |
| baseline 期待横排但当前为 0 | diff 失败并提示检查 suite/fixture |

### 5. Good / Base / Bad Cases

- Good：横排 suite 的 47 个横排 region 全部评分，704 个字符在 `horizontal-glyphs.csv` 中可定位，竖排 6 个 region 的原分数保持独立。
- Base：纯竖排默认 suite 的 horizontal summary 为零值，原竖排报告和 diff 继续可用。
- Bad：把横排 region 混入 `avgCompositeScore`，会静默改变历史 baseline 含义。
- Bad：为提高 coverage 把缺失 GT X 替换为行中心，会把无标注误当成排版偏差。

### 6. Tests Required

- `tests/benchmark/horizontal-metrics.test.ts`：完美重合、X/Y 偏移、旋转 quad、跨行重排、重复/增删字符、离群点、额外行、缺 X 和空行。
- `tests/benchmark/horizontal-summary.test.ts`：字符距离按所有逐字诊断全局聚合，不能平均 region percentile。
- `tests/benchmark/baseline.test.ts`：旧 baseline 跳过横排、显式横排 baseline 参与比较、当前横排消失时报错。
- 真实 suite：`npm run bench -- --suite-dir benchmark/typeset/horizontal` 后确认横排 scored/skipped、字符数、逐字 CSV 和竖排兼容分。
- 完整门禁：两套 strict fixture audit、`npm run check`、`git diff --check`。

### 7. Wrong vs Correct

#### Wrong

```typescript
if (region.direction === "h") {
  return emptySkippedRegion(region.id, "horizontal");
}
```

#### Correct

```typescript
const computation = computeHorizontalRegionMetrics(
  region.groundTruth.columns,
  debugRegionToColumns(debugRegion),
  debugRegion.fittedFontSize,
  config.horizontalScoreWeights,
);
```

横排指标只读取 fixture GT 和 render debug；任何差异都写入报告，不得反馈修改 renderer 输入。

---

## 场景：Typeset Fixture 源列几何契约

### 1. Scope / Trigger

- 触发：修改 `benchmark/typeset/` 的 bake、render、metrics/report 脚本，或修改 `src/pipeline/bake.ts` 输出给 fixture 的字段。
- 目标：`sourceText`、`sourceLineGeometries`、`groundTruth.columns` 必须来自同一组 OCR/merge 源列，避免把旧 fixture 的列顺序错配误判成 typeset 字间距问题。

### 2. Signatures

- `BakeResultRegion.detectedColumns?: DetectedColumn[]`
- `FixtureRegion.sourceText: string`
- `FixtureRegion.groundTruth.columns: GroundTruthColumn[]`
- `RenderFixtureRegion.sourceLineGeometries?: SourceTextLineGeometry[]`
- `BenchmarkSummary.sourceGeometryUsableRegionCount: number`
- `BenchmarkSummary.sourceGeometryRejectedRegionCount: number`
- `BenchmarkSummary.sourceGeometrySpatialOrderMismatchCount: number`
- `BenchmarkSummary.sourceGeometryRejectedReasons: Record<string, number>`
- `npm run bench:audit-fixtures -- [--fixtures-dir path] [--strict]`
- `npm run bench:bake-node -- --out-dir <report-fixtures-dir>`

### 3. Contracts

- 新 bake 优先从 `merged.sourceLineGeometries` 生成 `detectedColumns`；只有缺失时才回退到 pre-merge `centerInBox` 匹配。
- `detectedColumns.charCount` 和 fixture `charCenters` 必须按 `text.replace(/\s+/g, "")` 的字形数计算，不能把换行/空白当成竖排字符。
- `bake-node.ts` 和 `bake-fixtures.ts` 必须支持 `--out-dir`，用于先把重 bake 产物写到 `benchmark/reports/` 下的临时目录；不要把未经审计的新 fixture 直接覆盖正式 `benchmark/typeset/fixtures/`。
- 替换正式 fixture 前，必须对临时输出执行 `npm run bench:audit-fixtures -- --fixtures-dir <dir> --strict`；替换后必须再对正式目录执行 `npm run bench:audit-fixtures -- --strict`。
- benchmark render 只能复现 fixture 输入：`sourceText` 保持不变，`sourceLineGeometries` 可由旧 fixture 的 GT 几何近似，但不得在 render adapter 中按诊断结果重写或重排。
- 旧 fixture 若文本能匹配但空间右到左顺序不同，允许继续用全局几何统计稳定视觉，但必须报告 `spatial_order_mismatch`；这类区域不能作为逐列字距拟合的真值。

### 4. Validation & Error Matrix

- `sourceText` 列数为 0 -> `empty_source_text`，不传 `sourceLineGeometries`。
- `sourceText` 列数 != `groundTruth.columns.length` -> `column_count_mismatch`，不传 `sourceLineGeometries`。
- 任一 `sourceText` 列文本无法在 GT 中找到未使用匹配 -> `text_mismatch`，不传 `sourceLineGeometries`。
- 文本集合可匹配但 `sourceText` 顺序 != GT 空间右到左顺序 -> `spatial_order_mismatch`，可传几何但报告计数。

### 5. Good/Base/Bad Cases

- Good：新 bake 的 `sourceText`、`sourceLineGeometries`、`groundTruth.columns` 都来自 `merged.sourceLineGeometries`，列顺序一致。
- Base：旧 fixture 文本可匹配但空间顺序不同，报告标出 `spatial_order_mismatch`，视觉仍可用几何锚点。
- Bad：直接把 `groundTruth.columns` 空间排序后重写 `sourceText`，会造成列文本错位。

### 6. Tests Required

- 单测 `benchmark/typeset/src/source-geometry.ts`：覆盖文本匹配、文本失败、列数失败、空间顺序不一致。
- 单测/回归 `fontFit`：源几何 profile 的 pitch/anchor 按空间右到左统计；`medianAdvance` 保留全局 fallback；per-column advance 必须按源文本列匹配，且匹配后的几何顺序不单调时返回空数组。
- Fixture 变更流程：先 `bench:bake-node -- --out-dir <report-fixtures-dir>`，再 `bench:audit-fixtures -- --fixtures-dir <report-fixtures-dir> --strict`；审计通过后才能备份并复制到正式目录。
- 端到端验证：`npm run bench:render` 后执行 `npm run bench`，确认 summary 输出 source geometry 诊断字段。

### 7. Wrong vs Correct

#### Wrong

```typescript
// Diagnostic/GT order must not rewrite benchmark render input.
sourceText: resolveFixtureRenderSourceText(region) ?? region.sourceText
```

```typescript
// Do not feed source-order diagnostics back into renderer geometry.
sourceLineGeometries: resolveFixtureSourceLineGeometries(region)
```

#### Correct

```typescript
// Render should reproduce the fixture input; diagnostics are reported separately.
sourceText: region.sourceText
sourceLineGeometries: region.groundTruth.columns.map(groundTruthColumnToSourceGeometry)
```

#### Cross-Layer Rule

- `groundTruth.columns` is the evaluation/annotation layer.
- `sourceText` and `translatedColumns` are render input layer.
- `sourceGeometryStatus` is diagnostic layer.
- Never let evaluation or diagnostic ordering rewrite render text order. Old fixtures may have `sourceText`, GT array order, and GT spatial order disagreeing; report that mismatch, but do not "fix" render input inside `render-result.ts`.

### Vertical Source Advance Contract

- Source geometry has two separate consumers:
  - spatial geometry (`medianPitch`, anchor, group center) is resolved from right-to-left column positions;
  - glyph advance targets must be aligned to source text/render column order.
- Keep a global `medianAdvance` fallback derived from spatial source columns. This preserves stable behavior when per-column mapping is unsafe.
- Enable per-column advance only when source geometry text can be matched to `sourceText` columns and the matched geometry is right-to-left monotonic.
- If source text, GT array order, and spatial order disagree, do not use per-column advance. Using a per-column advance from a mismatched column moves height/spacing from one visual column to another and creates the same class of position regressions as rewriting `sourceText`.
- Benchmark diagnostics may report `spatial_order_mismatch` or `text_mismatch`; those statuses are evidence to avoid per-column runtime feedback, not permission to reorder render input.

## 场景：竖排字形质量诊断

### 1. Scope / Trigger

- 触发：修改 typeset debug schema、`glyph-quality.ts`、render overlay 或排版报告字段。
- 目标：几何位置和字形方向分别评分，同时保持 render input、GT 和诊断层隔离。

### 2. Signatures

```typescript
type VerticalGlyphQualityMetrics = {
  glyphQualityCoverage: number;
  glyphOrientationAccuracy: number;
  runContinuityRate: number;
  verticalItemCenterAlignment: number;
  glyphQualityScore: number;
};
```

### 3. Contracts

- `compositeScore` 继续表示旧几何指标；`glyphQualityScore` 表示 layout-item 方向、run 连续性和中心归属，不得互相覆盖。
- 预期方向从 render input 文本推导，实际方向来自 `columnVerticalItems`；诊断只能比较和报告，不能改写文本或列顺序。
- 旧 debug 缺少 `columnVerticalItems` 时 coverage/score 为 0，不能默认视为兼容通过。
- overlay 使用不同颜色显示 upright、sideways 和 tate-chu-yoko item 中心，但不得影响 render PNG。

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| render debug 文件缺失 | 要求先运行 `bench:render` |
| region 缺少 `columnVerticalItems` | glyph-quality 为 0，几何指标仍可独立计算 |
| 预期 Latin run 被拆开 | `runContinuityRate` 下降 |
| item 中心落在列框之外 | `verticalItemCenterAlignment` 下降 |
| mixed/纵中横让几何 GT 分下降 | 同时报告 geometry 与 glyph-quality，不用诊断修改 GT |

### 5. Good / Base / Bad Cases

- Good：`AveMujica` 的 geometry 可能因正确旋转而变化，但 run continuity 和 orientation 均为 1。
- Base：纯 CJK 区域没有 sideways run，`runContinuityRate` 记为 1。
- Bad：为了恢复旧 IoU，把一个正确的 tate-chu-yoko 拆回两个竖排字符。

### 6. Tests Required

- `tests/benchmark/glyph-quality.test.ts` 覆盖完整、旧日志和 run 破坏场景。
- `npm run bench:audit-fixtures -- --strict` 必须先通过。
- `npm run bench:render` 后运行 `npm run bench`，确认 geometry 与 glyph-quality 均出现在 JSON、Markdown 和控制台。

### 7. Wrong vs Correct

#### Wrong

```typescript
// Do not rewrite runtime input from a diagnostic mismatch.
region.translatedColumns = expectedItems.map((item) => item.sourceText);
```

#### Correct

```typescript
const geometry = computeRegionMetrics(gt, predicted, fontSize, weights);
const glyphQuality = computeVerticalGlyphQuality(debugRegion);
```

## 场景：浏览器 Paddle Profile Benchmark

### 1. Scope / Trigger

- 触发：修改 `benchmark/perf/src/run-browser-paddle-profile.ts`、`src/benchmark/browserEntry.ts`，或需要在 Chromium/WebGPU 中分析 `paddleocr_v6_medium` 端到端耗时。
- 目标：用真实浏览器 provider、stage timings 和 Paddle OCR debug 判断 cold/warm 瓶颈，不用 Node CPU 结果替代 WebGPU 结论。

### 2. Signatures

```bash
npm run bench:browser-paddle-profile -- [--image=<local-image>] [--runs=3] [--process-mode=erase|original|translate] [--paddle-batch|--paddle-serial] [--paddle-provider=default|webgpu|webnn|wasm] [--paddle-cold-first-serial|--paddle-no-cold-first-serial] [--paddle-model=medium] [--paddle-runtime-probe=legacy|prepare|warmup] [--paddle-prepare|--paddle-warmup] [--paddle-probe-schedule=detect-start|after-detect|bubble-start|after-bubble|ocr-start] [--inpaint-probe-schedule=current|detect-start|after-detect|bubble-start|after-bubble|ocr-start] [--paddle-fixed-width=<px>] [--paddle-graph-capture]
```

- npm script 固定附加 `--ocr-engine=paddleocr_v6_medium --process-mode=erase`；用户传入的同名 `--name=value` 取最后一个值。
- runner 只有一个当前 Paddle result，不包含 old/current mode 或 AR compare selector。
- `--image` 读取本地 fixture 并转为 data URL，避免 X 页面登录/网络状态影响性能判断。
- `--paddle-batch` 强制 width-bucket；`--paddle-serial` 强制逐 region；未传时使用 runtime 默认 provider-aware 策略。
- `--paddle-provider` 只用于 benchmark 内临时覆盖 Paddle recognition provider，用于回答 WebGPU/WebNN/WASM 对照问题；正式 pipeline 默认 fallback 不变。
- `--paddle-cold-first-serial`/`--paddle-no-cold-first-serial` 只用于 benchmark 对照 WebGPU cold session 的首个 inference 分组策略；默认策略由 Paddle provider 决定。
- `--paddle-model` 当前只允许 `medium`；`small` 属于历史实验候选，当前主分支不发布对应模型文件，也不提供前端模型选项。
- `--paddle-runtime-probe=prepare` 在用户触发 pipeline 后的 runtime probe 中准备 Paddle session/字典；`--paddle-warmup` 进一步执行固定 shape warmup inference。
- `--paddle-probe-schedule` 只用于 benchmark 调度实验，控制 Paddle OCR runtime probe 的启动点；默认 `detect-start` 保持既有行为。
- `--inpaint-probe-schedule` 只用于 benchmark 调度实验，控制 inpaint runtime probe 的启动点；默认 `current` 保持既有行为，即 OCR runtime probe 完成后、OCR inference 前启动。
- `--paddle-fixed-width=<px>` 把 Paddle 输入 padding 到固定宽度，用于静态 shape/warmup 对照；实际运行宽度不得小于本轮任一 OCR crop 的 `resizedWidth`，需要自动抬高并在报告中保留最终 `fixedInputWidth`，因为它会影响输出 time steps 和识别文本。
- `--paddle-graph-capture` 为 ORT WebGPU 实验开关，只能与固定 shape 一起验证；当前 Paddle CPU 输入和 CPU CTC decode 路径不满足外部 GPU buffer 合约。

### 3. Contracts

- Paddle profile report 必须包含 `stageTimings`、`ocrSummary.paddle` 和完整 `ocrDebug.paddle`。
- `ocrSummary.paddle` 至少包含 modelName、provider、batchMode、sessionOptionsKey、fixedInputWidth（如有）、inferenceRunCount、accepted/rejected/missing 计数、preprocess/inference/CTC/color 耗时、input/output bytes 和 width 分布。
- `ocrDebug.paddle.inferenceRuns[0]` 必须保留首个 inference 的 `inputDims`、`durationMs`、`outputDims`、`timeSteps` 和文本，cold-start 结论不能只看 OCR stage 总数。
- Browser profile 必须区分 cold run（`runIndex=0`）和 warm runs；性能结论优先使用 warm median，cold 结论单独说明 session/shape 编译成本。
- `processMode=erase` 覆盖本地检测、气泡、Paddle OCR、mask refine、inpaint；`processMode=original` 额外覆盖 typeset，不包含网络翻译。
- `paddleRuntimeProbeMode`、`paddleModelMode`、`paddleFixedInputWidth`、`paddleGraphCapture` 必须写入 `report.result`，避免多个实验报告混淆。
- `paddleRuntimeProbeSchedule` 和 `inpaintRuntimeProbeSchedule` 必须写入 `report.result`。分析 prepare 净收益时必须同时看 cold total、cold OCR、detect/bubble/inpaint stage；不能只看 OCR stage 变短。
- Paddle prepare/warmup 只能在用户触发翻译后的 pipeline 内启动，不得改成页面加载时预加载。

### 4. Validation & Error Matrix

| Condition | Symptom | Fix |
| --- | --- | --- |
| `dist` 未 build 或当前发布模型缺失 | benchmark 启动时报 missing dist asset | 先运行 `npm run build`，确认 `detector.onnx`、`bubble.onnx`、`aot_inpaint_512.onnx`、`PP-OCRv6_medium_rec.onnx` 和 `paddleocr_v6_dict.txt` 存在 |
| 传入 `--paddle-model=small` | benchmark 试图引用已删除模型 | 使用默认 medium；如需重新评估 small，先按 frontend runtime-models spec 重新引入候选 |
| runner 出现 old/current 多模式 selector | 废弃 AR compare 入口回流 | 删除分支，只保留一个 `report.result` |
| 同名 CLI 参数由 npm script 默认值和用户 override 同时提供 | 用户 override 被忽略 | 参数解析取最后一个 `--name=value` |
| 只看 Node CPU profile | WebGPU shape/session 行为被误判 | 必须补浏览器 WebGPU profile，再决定默认策略 |
| `--paddle-graph-capture` 仍使用 CPU input/output | `External buffer must be provided for input/output index 0 when enableGraphCapture is true` | 记录为当前架构不支持；除非先实现 GPU external input/output 和 decode/readback 设计 |
| warmup 后 detect/bubble stage 异常变慢 | OCR stage 变快但 total 变差 | 以 cold total/warm median 作为净收益判断，不把 OCR 局部收益直接产品化 |
| fixed width 改变样本文本 | 速度可比但质量不可比 | 报告样本文本并标注 `fixedInputWidth`；质量退化时不推荐默认启用 |
| Paddle prepare 放在 `bubble-start` 后 cold OCR 很短但 total 变差 | prepare 与 bubble/WebGPU 初始化抢资源 | 不把 OCR 局部收益当作端到端收益；改测 `detect-start` 或 `ocr-start` |
| inpaint probe 过早启动导致 cold total 变差 | inpaint session 与 detector/Paddle session 争用 Worker/WebGPU | 保持 `--inpaint-probe-schedule=current`，除非 report 证明端到端净收益 |

### 5. Good/Base/Bad Cases

- Good：本地 fixture 用 `--runs=3` 跑默认 Paddle WebGPU，报告 cold OCR、warm median、Paddle inference/preprocess 和全流程 stage timings。
- Good：用 `--paddle-prepare` 验证用户触发后的懒准备收益，同时检查 detect/bubble 是否被 worker/GPU 争用拖慢。
- Good：对 prepare 调度实验使用同一图片、同一 runs，对比 `detect-start` / `after-detect` / `bubble-start` / `after-bubble` / `ocr-start`，并记录 `inpaintRuntimeProbeSchedule` 是否为默认。
- Base：用 `--paddle-serial` 跑对照，只比较 OCR 内部 inference/run count，不把 inpaint/detect 抖动误读为 batch 策略收益。
- Bad：只为重跑历史报告而恢复多模式 AR compare，并把已删除模型接回当前构建。
- Bad：把 cold run 的首次 WebGPU shape 编译成本混进 warm median，并据此判断热运行瓶颈。
- Bad：`--paddle-graph-capture` 报外部 buffer 错误后继续把它当作可上线优化；当前 Paddle logits 需要 CPU CTC decode，必须先补 GPU buffer/readback 设计。
- Bad：把 inpaint probe 提前到 detect-start 后只看 OCR 缩短；如果 cold total 或 detect/bubble 变差，应判定为调度争用。

### 6. Tests Required

- `npx tsc --noEmit --pretty false`
- `npm run test`
- `npm run build:benchmark`（npm script 已自动执行；直接运行 runner 前也必须先完成）
- `npm run bench:browser-paddle-profile -- --image=<fixture> --runs=3`
- `npm run bench:browser-paddle-profile -- --image=<fixture> --runs=3 --paddle-prepare`
- 调度实验：`npm run bench:browser-paddle-profile -- --image=<fixture> --runs=3 --paddle-prepare --paddle-probe-schedule=<schedule> [--inpaint-probe-schedule=<schedule>]`
- 如新增 Paddle 模型候选，先更新 `.trellis/spec/frontend/runtime-models.md`，再运行 `npm run models:check-paddle-ocr -- public/models/<model>.onnx public/models/paddleocr_v6_dict.txt`。
- 如验证 graph capture，失败也要记录原始错误；只有实现 GPU external input/output 后才把它列为通过项。
- 如改动 content/worker bundle 边界，再运行 `node --check dist/content.js dist/background.js dist/chunks/orchestrator.js dist/chunks/onnxWorkerBridge.js dist/onnxWorker.js`。

### 7. Wrong vs Correct

#### Wrong

```bash
tsx benchmark/perf/src/run-browser-paddle-profile.ts --runs=3
```

直接启动 runner 会绕过 benchmark build 和 Release 边界断言，可能测到陈旧 `dist`。

#### Correct

```bash
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3
```

报告中检查 `ocrSummary.paddle.provider === "webgpu"`、`batchMode`、`inferenceRunCount` 和各 stage median 后再下结论。

#### Correct: prepare 调度验证

```bash
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-prepare --paddle-probe-schedule=detect-start
```

对比同图同 runs 的其他 `--paddle-probe-schedule` 报告；只有 cold total 和 warm median 都不退化时，才把 prepare 调度视为可产品化候选。

---

## Quality Check

After modifying benchmark scripts, verify:

- [ ] `tsc --noEmit` 通过（TypeScript 类型检查）
- [ ] `vitest run` 全部通过（包括 `tests/benchmark/color-alg-diagnostic.test.ts`）
- [ ] 脚本可端到端运行（即使 fixture 图片缺失，也应优雅处理而非 crash）
- [ ] `import type` 用于类型导入，`type` 用于数据类型定义
- [ ] 无 `any` 类型

---

**Language**: Documentation written in **Chinese** (matching user-facing tool output).
