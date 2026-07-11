# 横排复用竖排布局闭环：实施计划

> 已按用户确认范围完成实现与验证；未写入任何后续任务。

## 1. 规划与契约锁定

- [x] 用户确认本任务包含“逐行气泡安全宽度 + 现有候选断点内重排”。
- [x] 实现前加载 `trellis-before-dev`，阅读 frontend/benchmark 相关规范和本任务文档。
- [x] 记录当前横排与竖排针对性测试基线。
- [x] 确认 `benchmark/images/` 继续保持任务范围外。

## 2. 测试先行：横排源几何

- [x] 在新的横排聚焦测试中覆盖：
  - [x] 合法横排源行画像；
  - [x] 从上到下空间顺序；
  - [x] 直接文本匹配与唯一文本匹配；
  - [x] 重复文本、数量不符、方向错误、无效尺寸和倾斜角降级；
  - [x] 全局统计可用但逐行映射不可用的分层降级；
  - [x] 源字号、pitch、group center Y。
- [x] 覆盖 left/center/right/unknown 对齐画像推断。

## 3. 实现横排源几何画像

- [x] 在 `sourceGeometry.ts` / `fontFitCore.ts` 增加横排画像类型和 resolver。
- [x] 复用现有稳健数值与角度 helper，新增横排 top-to-bottom 顺序判断。
- [x] 区分全局空间统计与逐行文字映射。
- [x] 将画像接入 `horizontalLayout.ts` 的初始字号、行距和 block anchor。
- [x] 保持无画像路径稳定回退。

## 4. 测试先行：行盒与安全宽度

- [x] 覆盖 Canvas 完整 metrics 与缺失 actual/font bounds 的 fallback。
- [x] 覆盖 baseline、ascent、descent、lineHeight 和 debug box 一致性。
- [x] 覆盖无 mask 的矩形宽度回退。
- [x] 覆盖不同 Y 带宽度和中间断开的 mask。
- [x] 覆盖安全边距和找不到连续安全区间的降级。
- [x] 覆盖旋转 region 不误用图像/局部坐标。

## 5. 实现横排行盒和 mask 宽度

- [x] 在 `horizontalFit.ts` 建立横排 line metrics 与 safe interval helper。
- [x] 让 `horizontalLayout.ts` 在每次字号候选下重新计算 baseline 和逐行 maxWidth。
- [x] 接入源 group center Y 和对齐画像，并对内容边界做 clamp。
- [x] 禁止逐行独立字号或 tracking。

## 6. 调整拟合顺序

- [x] 在现有模型分段、禁则和字符/单词候选内实现 reflow 优先策略。
- [x] 短尾场景先尝试回流，不立即缩字号。
- [x] 统一字距只作为受限微调，并在诊断中记录。
- [x] 二分字号候选同时检查总高度和逐行安全宽度。
- [x] 保留 fallback，确保不可靠源几何和无 mask 场景稳定。

## 7. 渲染与诊断

- [x] 修改 `renderHorizontal.ts`，消费布局生成的 x/baseline/line box。
- [x] stroke/fill 两遍使用相同布局项。
- [x] 真实墨迹 padding 与 debug box 使用同一度量上下文。
- [x] 扩展 `TypesetLayoutDiagnostics` 横排可选诊断字段。
- [x] 在 `drawTypeset.ts` 映射横排 profile、alignment、anchor 和 safe widths。
- [x] 旧 debug reader 缺少新字段时保持兼容。

## 8. 回归测试

- [x] 横排：单行、多行、短尾、模型分段、CJK 禁则、Latin fallback、无源几何、可靠/不可靠源几何、mask 轮廓、旋转 quad。
- [x] 竖排：orientation、sideways run、纵中横、源 advance、列距、列锚点、逐列起始位置和 mask 无回归。
- [x] `drawTypeset` 的横排 layout/render/debug schema 一致。
- [x] `src/pipeline/typeset/index.ts` 公共导出边界不变。

## 9. 验证命令

按顺序运行：

```bash
npx vitest run tests/pipeline/typeset/fontFit.test.ts tests/pipeline/typeset/drawTypeset.test.ts tests/pipeline/typeset/typesetGeometry.test.ts tests/pipeline/typeset/renderVertical.test.ts
npm run typecheck
npm run test
npm run build
npm run check
git diff --check
```

如果实现触及 typeset fixture adapter 或 benchmark debug schema，再追加：

```bash
npm run bench:audit-fixtures -- --strict
npm run bench:render
npm run bench
```

## 10. 风险文件与回滚点

| 文件 | 风险 | 回滚策略 |
| --- | --- | --- |
| `src/pipeline/typeset/fontFitCore.ts` | 横竖共享 helper 回归 | 横排 resolver 保持独立；先跑竖排聚焦测试 |
| `src/pipeline/typeset/sourceGeometry.ts` | 公共导出漂移 | 只导出 typeset 内部需要的横排画像 |
| `src/pipeline/typeset/horizontalLayout.ts` | 拟合顺序和换行变化范围大 | 每阶段保留旧 fallback/option |
| `src/pipeline/typeset/horizontalFit.ts` | mask 坐标和 line metrics 错误 | 纯函数测试覆盖图像/局部坐标 |
| `src/pipeline/typeset/renderHorizontal.ts` | baseline 与 padding 导致裁切 | render/debug 共用 line box，单独回滚渲染阶段 |
| `src/pipeline/typeset/drawTypeset.ts` / `src/types.ts` | debug schema 兼容 | 新字段可选，旧日志缺失时正常 |

## 11. 启动前审查门

- [x] PRD 验收条件可测试。
- [x] `design.md` 明确全局统计与逐行映射边界。
- [x] 用户确认范围并批准进入实现后，才执行 `python ./.trellis/scripts/task.py start 07-11-horizontal-typeset-vertical-layout-port`。

## 12. 实施结果

- `npm run check`：47 个测试文件、566 项测试全部通过，生产构建和 release artifact 边界检查通过。
- `npm run bench:audit-fixtures -- --strict`：14 份 fixture、114 个区域全部 clean。
- `npm run bench:render`：14 份 browser render debug 均已生成；命令在关闭浏览器阶段超过 120 秒窗口，但报告完整。
- `npm run bench`：综合分 `0.9358`，glyph quality/orientation/run continuity 均为 `1.0000`，列数匹配率 `100%`，源几何 `114/0` 可用/拒绝。
- `npm run bench:diff`：仓库当前没有 baseline，未创建或更新 baseline。
- `git diff --check`：通过；仅有仓库既有的 LF/CRLF 提示。
- `benchmark/images/`：保持任务范围外，未纳入改动。

## 13. 横排重点观察集与目录参数

- [x] 创建 `benchmark/typeset/horizontal/images|fixtures|reports` 和中文说明。
- [x] 新增共享 `suite-paths.ts`，统一解析默认目录、`--suite-dir` 和细粒度覆盖参数。
- [x] bake、bake-node、audit、render、bench、diff/baseline 全链路接入 suite 目录。
- [x] 修正横排 fixture render 的 `sourceLineGeometries.direction`。
- [x] 新增目录解析和横排 fixture adapter 单测。
- [x] 空 suite 的六条命令错误路径完成实测，不会回读默认数据。
- [x] 默认 fixture 严格审计保持 14 份、114 个区域 clean。
- [x] `npm run check`：49 个测试文件、571 项测试通过，生产构建与产物边界检查通过。

## 14. Benchmark bake 方向契约

- [x] `shinobuBake` 默认从竖排硬编码改为保留 `h | v`，并支持 `direction: all|h|v`。
- [x] 浏览器和 Node bake 接入相同的 `--direction` parser，并在 fixture 元数据中记录选择。
- [x] fixture builder 按方向生成 ground truth、字号估算和 snapshot 几何。
- [x] fixture audit 支持横排 top-to-bottom 空间顺序，保留竖排 right-to-left 行为。
- [x] 10 张横排观察图用浏览器 `--direction all` 重烘焙：53 个区域，其中 `h=47`、`v=6`；strict audit 全部 clean。
- [x] 同一观察集用 `--direction h` 实测：47 个区域全部为 `h`，`bakedWith.direction=h`；strict audit 全部 clean。
- [x] 同一观察集用 `--direction v` 实测：6 个区域全部为 `v`，`bakedWith.direction=v`；无竖排区域的图片保留空 fixture，strict audit 全部 clean。
- [x] 横排 suite render：10 份渲染图与 debug 生成成功，debug 保留 `h=47`、`v=6`，53 个区域全部启用源几何画像。
- [x] 横排 suite bench：旧竖排数值评分按契约跳过 47 个横排区域，对 6 个竖排区域评分，综合分 `0.9376`，源几何 `6/0` 可用/拒绝。
- [x] Node bake 单图 `--direction h` 实跑：3 个区域全部为 `h`，元数据方向为 `h`，strict audit 通过；CUDA 不可用时正常回退 CPU。
- [x] `npm run check`：51 个测试文件、578 项测试通过，生产构建与 release artifact 边界检查通过。
- [x] 默认 fixture strict audit：14 份、114 个区域全部 clean；横排 suite strict audit：10 份、53 个区域全部 clean。
- [x] Trellis task validate 与 `git diff --check` 通过。

## 15. 横排逐字中心可视化

- [x] 新增横排逐字 placement 纯函数，统一表达绘制原点、baseline、字宽和墨迹中心。
- [x] 横排 stroke/fill 渲染与 debug 共用同一份 placement；非空白字符写入 `columnGlyphCenters`。
- [x] fixture 横排 GT/current snapshot 输出二维 `{x,y}` 字符中心；旧 `{y}` fixture 保持兼容。
- [x] overlay 优先使用字符自身 x，缺失时回退列中心。
- [x] 针对性测试覆盖 placement、debug 和 fixture 二维中心。
- [x] 重烘焙 10 份横排 fixture：47 个横排区域包含 704 个二维 GT 字符中心，6 个竖排区域保持 104 个一维中心；strict audit 全部 clean。
- [x] 重生成 overlay：47 个横排区域全部输出实际字符中心，共 704 个，无空区域。
- [x] `npm run check`：51 个测试文件、578 项测试通过，生产构建与 release artifact 边界检查通过。
- [x] 横排 benchmark 分数保持 `0.9376`，默认竖排 fixture 114/114 clean，Trellis validate 与 `git diff --check` 通过。

## 16. Source quad 绿色框

- [x] bake/fixture 增加可选 source line quad，保持 detector/merge 四点几何。
- [x] 横排 GT 字符中心沿 quad 左右边中点连线插值；竖排对称支持上下边中线。
- [x] fixture render adapter 优先 round-trip 原 quad，旧 fixture 使用矩形 fallback。
- [x] overlay 优先直接描 GT quad，消除 AABB 原点与 intrinsic 边长混用导致的横排偏小。
- [x] 单测覆盖旋转横排 quad、字符中心和 render round-trip。
- [x] 重烘焙后 53 个区域、94 条源文字行全部保留 quad（横排 82、竖排 12），strict audit 全部 clean。
- [x] 新 overlay 已生成，倾斜横排绿框与字符点沿真实 quad/中线分布。
- [x] `npm run check`：51 个测试文件、578 项测试通过；默认竖排 fixture 114/114 clean。
- [x] 横排 benchmark 综合分 `0.9374`；核心 IoU、字号误差、间距和列数指标不变，轻微总分变化来自真实旋转 quad round-trip 与轴对齐旧评分的差异。
- [x] Trellis validate 与 `git diff --check` 通过。

## 17. 横排数值评分

- [x] `RegionMetrics` 改为横排、竖排和 skipped 的方向联合类型；旧竖排综合分与权重保持不变。
- [x] 新增旋转 quad/文字块 IoU、行中心/宽高/行距/角度、字号、换行和逐字二维距离指标。
- [x] 字符按 grapheme 全文有序匹配，支持跨行重排、重复字符和增删字符；缺少 GT X 时明确跳过。
- [x] 新增方向化 JSON/Markdown/per-region CSV 和 `horizontal-glyphs.csv`，横排最差 region 按字符 P95 排名。
- [x] baseline 支持可选横排段；旧 baseline 跳过横排，横排样本从已建立 baseline 中消失时失败。
- [x] 十图 suite：47 个横排 region 全部评分、0 skipped，704/704 字符完成二维匹配；横排综合分 `0.7320`。
- [x] 字符距离为 mean `0.9215em`、median `0.5310em`、P95 `3.0445em`、max `14.7087em`；超过 `0.5em`/`1em` 的比例为 `54.0%`/`27.0%`。
- [x] 同一混排报告中的 6 个竖排 region 综合分保持 `0.9374`；默认竖排报告 114 个 region 全部评分。
- [x] 横排 suite 53/53、默认 suite 114/114 strict audit 通过。
- [x] `npm run check`：54 个测试文件、593 项测试通过，生产构建与 release artifact 边界检查通过。
- [x] `bench:diff --suite-dir benchmark/typeset/horizontal` 确认当前未建立 baseline，本次未自动创建。
- [x] `git diff --check` 通过；`benchmark/images/` 继续保持任务范围外。
