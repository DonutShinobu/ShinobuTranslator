# 竖排字形方向调研与现状证据

## Research question

为什么当前 Canvas 竖排中 `~ / ～ / 〜`、日文长音符、破折号和拉丁字符形态异常，以及怎样建立不破坏现有几何布局的系统性修复？

## Authoritative references

1. [Unicode Standard Annex #50: Unicode Vertical Text Layout](https://www.unicode.org/reports/tr50/)
   - 当前稳定版本对应 Unicode 17.0.0。
   - 定义 `U`、`R`、`Tu`、`Tr` 四种 Vertical_Orientation。
   - 方向应用于 grapheme cluster；字体 `vert` 特性和布局软件共同决定最终替换/旋转。
   - U+30FC `ー` 属于需要竖排变形、回退时旋转的类别。
2. [Unicode VerticalOrientation.txt](https://www.unicode.org/Public/UCD/latest/ucd/VerticalOrientation.txt)
   - 官方机器可读 code point/range 数据源。
   - 实现应在开发期固定版本并生成压缩表，不能在运行时依赖 latest URL。
3. [W3C CSS Writing Modes Level 4](https://www.w3.org/TR/css-writing-modes-4/)
   - `text-orientation: mixed` 说明横排脚本在竖排中通常顺时针旋转，CJK 字符通常直立。
   - `text-combine-upright` 为短数字/拉丁片段的纵中横行为提供产品参照。

## Local code evidence

### Character substitution

`src/pipeline/typeset/columns.ts` 的 `CJK_H2V` 当前包含：

- `— -> ︱`
- `― -> |`
- `– / - / − -> ︲`
- `_ -> ︳`
- `… -> ⋮`、`⋯ -> ︙`
- `~ / 〜 / ～ -> ︴`

该表没有 U+30FC `ー`，也没有表达替换失败后的旋转方向。把三种 wave/tilde 全部映射到 FE34 是当前怪异短波形的直接原因。

### Layout model

`src/pipeline/typeset/fontFit.ts` 的竖排路径先删除空白，再用 `[...text]` 拆 code point，随后生成只有 `ch` 与 `advanceY` 的 `VerticalGlyph`。后果是：

- grapheme cluster 可能被拆散；
- 英文单词边界在布局前丢失；
- 数据层无法表达旋转角度或纵中横；
- 空白在英文 run 识别前被删除。

### Canvas rendering

`src/pipeline/typeset.ts` 的 `renderVertical` 对每个 glyph 直接调用 `strokeText` 和 `fillText`，没有 `ctx.rotate`，也无法触发 OpenType `vert` / `vrt2`。因此映射表之外的横排 glyph 必然保持原方向。

### Metrics

`benchmark/typeset/src/metrics.ts` 当前 composite 由列数、rect IoU、字号、dx 和字符中心 dy 构成。它能证明几何接近，但不能判断：

- `ー` 是横线还是纵线；
- `︴` 是否替错；
- 英文 run 是否旋转；
- 单词是否被无理由拆列；
- 描边和填充是否使用相同 transform。

因此最新 14 张 fixture 报告即使得到 `0.9370` composite，也不能否定用户观察到的字形错误。

## Fixture evidence from the current 14-image set

- 第 1 张：`~●` 被渲染为 `︴●`。
- 第 2、7、8、12 张：多处 `～ / 〜` 被统一替换为 `︴`。
- 第 11 张：拉丁/数字空格被删除，字符逐个直立。
- 第 13 张：`AveMujica` 被逐字直立并跨列拆成 `AveMu` / `jica...`。
- 第 14 张：`そうだねーー` 中 `ー` 保持横线；下划线另行映射为纵线，暴露了字符替换的不一致。

后续核对原图与 fixture 发现，同一区域另一列的原图是 `ん` 后连续竖向长音符，而 fixture/OCR 文本为 `んー_lll`。这是 OCR 线状字形混淆，不属于 typeset 方向规则；排版层不得通过 `_ -> ー`、重复 `lll` 直立或邻接字符猜测来掩盖该错误。

本轮 fixture 中未发现真正的 U+2014 `—`。因此用户所称的“破折号”主要对应日文长音符 `ー`，但系统性修复仍需覆盖两者并保持语义区分。

## Upstream comparison

本地参考源码 `.tmp/manga-image-translator-src/manga_translator/rendering/text_render.py` 同样包含相近的 CJK 替换表，但其兼容函数至少能为 `ー` 返回 90° 旋转意图；当前 TypeScript 的 `VerticalGlyph` 没有传递这一信息的字段。

该对比只证明当前移植缺失了“方向/旋转”数据通道，不把上游实现视为可直接照搬的完整答案。浏览器 Canvas、字体和当前源几何契约仍需本项目自己的设计与验证。

## Decision

采用以下技术基线：

1. UAX #50 固定版本 range table 提供基础方向。
2. 项目 tailoring 只负责经过字体验证的 presentation-form 替换和明确的漫画排版策略。
3. 方向作为 layout item 的判别类型贯穿测量、换列、渲染和 debug。
4. Canvas 对无法访问 `vert` glyph 的情况使用显式旋转回退。
5. 逻辑测试、浏览器视觉 fixture 和真实 14 张 fixture 三层验证。
6. 几何质量与字形方向质量分开评分、共同作为通过条件。

## Confirmed product decisions

- 默认采用接近 Unicode/CSS mixed 的策略：英文单词整体旋转、全大写短缩写及单个字母直立、1–2 位数字纵中横、更长数字整体旋转。
- 句末恰好两个问号/感叹号时，`!?`、`?!`、`!!`、`??` 及全/半角等价组合均复用两位数字的纵中横几何行为；该规则在单字符 `! / ?` 替换前执行。
- 单个、非句末及三个以上连续问号/感叹号不进入该特例，避免改变不同长度标点串的强调语义。
