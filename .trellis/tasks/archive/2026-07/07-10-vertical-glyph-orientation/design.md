# 竖排字形方向系统设计

## 1. Design objectives

本方案把“输入字符是什么”“竖排时应采用什么方向”“布局占多少空间”“Canvas 如何绘制”拆成独立契约。核心目标是让竖排方向成为一等数据，而不是继续在字符替换表和 `fillText` 循环中追加例外。

必须同时满足两条边界：

1. 修复字形方向，但不破坏已建立的源文本几何、字号/步进解耦和气泡布局。
2. 评测既能判断几何位置，也能识别字形方向；二者分别报告，避免视觉错误被高几何分掩盖。

## 2. Standards baseline

- Unicode UAX #50 定义 `U`、`R`、`Tu`、`Tr` 四类 Vertical_Orientation，并要求按 grapheme cluster 应用方向。
- CSS Writing Modes 的 `text-orientation: mixed` 提供产品行为参照：CJK 通常直立，仅横排脚本通常顺时针旋转；短横排片段可用纵中横。
- Canvas 2D 当前路径不能直接请求字体的 OpenType `vert` / `vrt2` 特性，因此设计必须有显式 Unicode 竖排替换和旋转回退。
- 规则表固定到 Unicode 17.0.0；升级 Unicode 版本时重新生成并单独评审 diff。

详细来源和现状证据见 `research/vertical-text-standards.md`。

## 3. Current failure model

```text
translated text
  -> remove whitespace
  -> split to code points
  -> CJK_H2V replacement
  -> one VerticalGlyph(ch, advanceY) per code point
  -> fillText/strokeText without transforms
```

该模型丢失了三个必要信息：grapheme 边界、连续拉丁 run、字形方向。`CJK_H2V` 同时承担“语义替换”和“视觉方向”导致 `~ / 〜 / ～` 被错误归一；`VerticalGlyph` 无旋转字段导致 `ー` 和拉丁文本无法按竖排规则绘制。

## 4. Proposed data flow

```text
translated text
  -> grapheme segmentation
  -> Unicode vertical-orientation classification
  -> project tailoring and validated presentation-form substitution
  -> Latin/digit run coalescing
  -> column wrapping and kinsoku over layout items
  -> item-aware measuring and advance allocation
  -> shared stroke/fill Canvas renderer
  -> versioned debug data and benchmark metrics
```

方向分类必须先于换列；否则 `AveMujica` 会先被拆成单字，后续无法恢复单词边界。

## 5. Type contracts

建议在 `fontFit.ts` 附近建立纯类型与纯函数模块，最终文件位置在实现阶段按依赖方向确定。

```ts
type VerticalOrientation =
  | "upright"
  | "sideways"
  | "transformed-upright"
  | "transformed-sideways";

type VerticalLayoutItem =
  | {
      kind: "upright-glyph";
      sourceText: string;
      displayText: string;
      orientation: "upright" | "transformed-upright";
      advanceY: number;
      offsetX: number;
      offsetY: number;
    }
  | {
      kind: "sideways-run";
      sourceText: string;
      displayText: string;
      orientation: "sideways" | "transformed-sideways";
      rotationDeg: 90;
      advanceY: number;
      measuredWidth: number;
      measuredHeight: number;
    }
  | {
      kind: "tate-chu-yoko";
      sourceText: string;
      displayText: string;
      advanceY: number;
      scale: number;
      measuredWidth: number;
      measuredHeight: number;
    };
```

生产类型还需携带 grapheme/source range 或稳定 item id，便于调试日志把布局结果追溯到原文。方向值不使用多个布尔字段组合，避免出现既 upright 又 rotated 的非法状态。

## 6. Grapheme segmentation and classification

### 6.1 Segmentation

- 首选 `Intl.Segmenter` 的 grapheme granularity，覆盖组合附加符、变体选择符和 emoji sequence。
- 保留一个基于 `Array.from` 的确定性降级路径；降级能力在类型和测试中显式标注。
- 现有无条件 `replace(/\s+/g, "")` 需要收敛：CJK 列间空白可规范化，但拉丁 run 内的语义空格不能在 run 识别前丢失。空白策略作为独立 token 处理。

### 6.2 Unicode table

- 通过开发期脚本从官方 `VerticalOrientation.txt` 生成压缩 range table；生成物随源码提交并记录 Unicode 版本。
- 运行时二分查找 code point range，返回 UAX #50 的基础值。
- 对多 code point grapheme，按 UAX #50 的 grapheme 规则归并；无法安全归并时采用基础字符方向并记录 debug reason。

### 6.3 Project tailoring

Unicode 分类后再应用项目级 tailoring：

- `U`：保持直立。
- `Tu`：若存在经过字体截图验证的 presentation form，则替换；否则保持直立。
- `R`：顺时针旋转 90°。
- `Tr`：若存在经过验证的竖排替代则使用；否则旋转原 grapheme。
- `ー`：作为 transformed-sideways 路径处理；Canvas 无 `vert` 特性时旋转原 glyph，避免保留横线。
- `ー` 的方向不接受连续、句尾或邻接字符特判；`そうだねーー` 中两个 grapheme 分别走相同的 `Tr` 回退。
- `~ / 〜 / ～`：分别保留 source identity，不再统一映射为 `︴`；按各自 Unicode 值和字体验证结果选择替代或旋转。
- 破折号、连接号、下划线、省略号、括号和句读点从同一表驱动；现有替换只有在 bundled font 下验证正确后保留。

tailoring 表的每一项包含 `source`、`display`、fallback orientation、reason 和测试用例，不允许继续散落在渲染循环里。

## 7. Latin, digit and terminal-punctuation policy

已确认采用 mixed 规则：

- 单个拉丁字符和 1–4 字符的全大写缩写保持逐 grapheme 直立。
- 含小写字母的英文单词、品牌名、CamelCase 或较长拉丁序列合并为一个 sideways run，整体顺时针旋转 90°。
- 1–2 位纯数字合并为 `tate-chu-yoko`，压缩到一个 CJK em 方框中横向直立显示。
- 3 位及以上连续数字作为 sideways run；符号与数字的组合由 token 规则决定，不凭单个字符猜测。
- 句末恰好两个问号/感叹号组成的 `!?`、`?!`、`!!`、`??` 均合并为一个 `tate-chu-yoko`，使用与两位数字相同的测量、缩放和居中机制，但通过 policy/reason 字段区分 `terminal-punctuation` 与 `short-digits`。
- 全角和 ASCII/全角混合组合在分类时进入相同 policy；`sourceText` 保留原字符与顺序，`displayText` 负责最终视觉形式。
- 句末判定允许其后只出现闭合引号或闭合括号；组合本身保持原子性，随后继续布局闭合符号。
- 组合识别顺序高于单字符竖排替换，确保 `!`、`?` 不会先变成 `︕`、`︖`。
- matcher 只接受长度恰好为 2、且两个 grapheme 都属于 `! / ！ / ? / ？` 的句末 token；单个、非句末和长度至少为 3 的标点串不匹配。

run 识别以 Unicode Script / General Category、句末位置和明确的连接符/闭合符号白名单为依据。建议的识别优先级是：句末双标点 -> 短数字纵中横 -> 拉丁/长数字 run -> 单 grapheme 方向与替换。连续英文单词优先作为原子项换列；若单个 run 的占用超过可用列高，则依次尝试：在安全边界拆分、按最小允许比例缩放、最终按 grapheme 回退，并输出 debug reason。

## 8. Measuring and layout

### 8.1 Upright glyph

保留当前源字符步进优先的策略。presentation form 替换后重新测量墨迹框，但 `advanceY` 仍遵守“源几何步进与字号解耦”的既有契约。

### 8.2 Sideways run

- 使用完整 run 的 `measureText` 宽度作为旋转后的主要纵向墨迹长度。
- 横向 font ascent/descent 在旋转后形成横向墨迹宽度，不再用 `国` 的 box 代替。
- `advanceY` 由真实 ink width、旋转后 cross size 和基于 CJK cell 的边界留白共同确定；气泡扩展高度不能参与该值计算。
- Latin run 保持等比光学校准，源逐字符 advance 只参与邻接留白目标，不得沿单词方向压扁整个 run；放不下时由统一字号拟合或换列解决。
- `actualBoundingBoxLeft/Right/Ascent/Descent` 用于计算 ink center offset；Canvas 缺失这些字段时回退 width/font size 和零偏移。
- run 的 wrap 判断使用 item advance，而字符计数仍只作为 debug 和回退依据。

### 8.3 Tate-chu-yoko

- 在一个基准 em 的纵向步进内绘制横向短数字或句末双标点。
- 当真实宽度超过允许 box 时按下限缩放并居中；不得改变整列字号。
- 数字与句末标点复用几何实现，但保留不同 policy，防止后续扩展规则时依赖字符串猜测来源。

### 8.4 Columns and kinsoku

- `splitToColumns` 或其后继函数接收 layout items，同时保留 source grapheme 供禁则判断。
- CJK 标点禁则继续基于原字符语义；presentation-form 替换不改变禁则类别。
- preferred columns、source line geometries、rotated quad、bubble mask 的计算顺序不变。

## 9. Canvas rendering

建立单一 `renderVerticalItem(ctx, item, style, center)` 路径，描边与填充都调用相同的 transform helper：

- upright glyph：维持当前居中基线，应用测量得到的细调 offset。
- sideways run：`save -> translate(center) -> rotate(Math.PI / 2) -> stroke/fill horizontal run -> restore`。
- transformed-sideways 单 glyph：走同一旋转路径，避免为 `ー` 再写特殊绘制代码。
- tate-chu-yoko：在一个 em box 内横排、不旋转、缩放并居中。

旋转中心使用 layout item 的逻辑中心，而不是直接用字符 baseline。描边与填充共享字体、scale、rotation 和 offset，防止出现双影。

描边样式对所有 item 保持一致，不为 `ー`、wave、dash 或其他细线 glyph 增加 source-specific `lineWidth` 分支。

## 10. Debug and benchmark design

### 10.1 Debug schema

为每个 item 输出：

- stable id、source range、`sourceText`、`displayText`
- `kind`、Unicode orientation、最终 policy、rotationDeg、fallback reason
- logical center、advance box、ink box、column index

现有 glyph centers/column boxes 保持可读；新增 schema version，benchmark 同时兼容旧报告一个过渡周期。

### 10.2 Test pyramid

1. **纯逻辑单测**：Unicode range lookup、grapheme、tailoring、Latin/digit run、四类句末双标点及全/半角与闭合符号识别、三连非匹配、超长 run 回退。
2. **布局契约测试**：item advance、wrap、禁则、源几何缩放、横排共享 helper 回归。
3. **浏览器视觉 fixture**：固定 Chromium、DPR 和 bundled font，检查旋转后 ink box、中心与截图。
4. **14 张真实 fixture 回归**：关注 7、12、13、14，同时保留全量几何指标。

### 10.3 Metrics

新增独立指标，不直接覆写旧 composite：

- `glyphOrientationAccuracy`：debug item 与期望方向/角度匹配率。
- `runContinuityRate`：期望连续的英文 token 未被无理由拆分的比例。
- `inkBoxAlignment`：旋转/替换后墨迹框中心与逻辑中心误差。
- `visualFixturePassRate`：专用浏览器 fixture 的确定性视觉检查结果。

报告顶部并列展示 geometry 和 glyph-quality；只有两组都达标才判定竖排回归通过。

## 11. Compatibility and migration

- 第一阶段保留 `VerticalGlyph` 到新 item 的适配器，使分类/渲染可分步落地。
- 迁移完成后删除只支持单字符的旧入口和重复映射，避免双轨长期存在。
- debug schema 版本化，benchmark 读取旧字段时明确标记 `orientation: unknown`，不伪造通过。
- Unicode 规则生成物、tailoring 表和 font snapshot 一起评审；字体文件升级时必须重新跑竖排视觉 fixture。

## 12. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Canvas 字体度量跨环境漂移 | 固定 Playwright Chromium、bundled font、DPR；逻辑断言与视觉断言分层 |
| 英文 run 旋转后占用过长 | 原子换列 + 安全边界拆分 + 有下限的缩放回退 |
| 新 item 模型破坏源几何步进 | 单独测试 font size、source advance、content height、bubble height 四个契约 |
| 标点替换与禁则互相影响 | 禁则始终基于 source grapheme，display form 只服务渲染 |
| 句末双标点被单字符替换提前吞掉 | 在 tokenization 阶段先识别双标点组合，并用优先级单测锁定 |
| 三连标点被错误压成双标点 + 单标点 | matcher 要求整段连续标点串长度恰好为 2，并增加负向 fixture |
| 共享 helper 导致横排回归 | 横排测试先锁定，方向代码保持竖排专用入口 |
| Unicode 表增大 bundle | 生成合并后的 range table，记录体积基线 |

## 13. Rollback strategy

- 新方向系统通过单一内部开关接入，出现严重回归时可回退到旧 `VerticalGlyph` 适配器。
- 回滚只切换分类/渲染入口，不回滚已验证的 fixture、debug schema 读取兼容和测试资产。
- 任何回滚都必须在报告中标明 glyph-quality 未启用，禁止继续只展示旧 composite 作为完整质量结论。
