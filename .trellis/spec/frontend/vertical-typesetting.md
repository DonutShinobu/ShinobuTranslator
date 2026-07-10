# Vertical Typesetting

## 1. Scope / Trigger

- 触发：修改 `src/pipeline/typeset/verticalOrientation.ts`、`columns.ts`、`fontFit.ts`、`typeset.ts`，或调整竖排 debug/benchmark 字段。
- 目标：Unicode 字形方向、连续 run、换列、Canvas transform 和诊断必须使用同一个 layout-item 契约，不能退回逐 code point 直立绘制。

## 2. Signatures

```typescript
type VerticalToken = UprightVerticalToken | SidewaysVerticalToken | TateChuYokoVerticalToken;

type VerticalGlyph = VerticalToken & {
  ch: string;
  advanceY: number;
  renderInlineScale: number;
  renderCrossScale: number;
  renderOffsetX: number;
  renderOffsetY: number;
  inkWidth: number;
  inkHeight: number;
  boundaryGap: number;
};

function tokenizeVerticalText(text: string): VerticalToken[];
function resolveUnicodeVerticalOrientation(grapheme: string): "U" | "R" | "Tu" | "Tr";
```

- Unicode 数据生成命令：`npm run typeset:generate-vertical-orientation`。
- 数据源固定为 Unicode 17.0.0 `VerticalOrientation.txt`，生成物为 `verticalOrientationData.ts`。

## 3. Contracts

- 先按 grapheme 分段，再识别句末双标点、短数字、Latin run，最后处理单字方向与 presentation form；方向分类必须发生在换列之前。
- `CJK_H2V` 只保存验证过的直立 presentation form。`~ / 〜 / ～ / ー / — / ―` 保留 source identity，并按 UAX #50 旋转回退。
- U+30FC `ー` 在 Canvas 无 `vert` 字形时始终走 `Tr -> transformed-sideways -> 90°` 回退；连续、句尾或相邻字符不得改变其方向。
- mixed 默认：单 Latin 字符及 1–4 个全大写缩写直立；含小写或超过 4 个大写字母的 run 整体顺时针旋转；1–2 位数字纵中横，3 位以上整体旋转。
- 句末恰好两个 `! / ！ / ? / ？` 组成的任意组合纵中横；允许其后只有闭合引号/括号。单个、非句末和三连以上不压缩。
- `sourceText` 用于禁则、回溯和 legacy char centers，`displayText` 只用于绘制；禁止用替换后的字符决定禁则。
- sideways run 的 `advanceY` 来自完整 run 的真实 ink width、旋转后 cross size 与边界留白；旋转中心用实际 ink center 补偿。Latin run 不得套用源逐字符 advance 做纵向非等比压缩，空间不足应交给统一字号拟合/换列处理。
- OCR 字符语义不在 typeset 层纠正。类似 `_lll` 的输入按 mixed 规则原样分类，禁止增加“重复 Latin 直立”或相邻字符猜测替换。
- tate-chu-yoko 在一个 em 内缩放。source advance、font size、content height、bubble height 继续独立。
- 描边与填充必须调用同一个 item transform。Canvas 顺时针旋转使用 `Math.PI / 2`。
- 所有 item 使用统一样式描边；不得按细线、长音符或特定 sourceText 修改 `lineWidth`。
- `columnVerticalItems` 是诊断输出，不得反馈进 runtime 换列或 source geometry。

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| `Intl.Segmenter` 不可用 | 回退到 `Array.from`，不能让排版失败 |
| Unicode range 未命中 | 按 `R` 回退并保留原 grapheme |
| `Tr` 没有验证过的 presentation form | 旋转原 glyph，不猜测替代字符 |
| Canvas 不提供 actual ink bounds | 宽度回退 `measureText().width`，高度回退 font size，中心 offset 为 0 |
| 句末标点串长度为 3 或更多 | 不拆成“双标点 + 单标点”纵中横 |
| 旧 debug 没有 `columnVerticalItems` | benchmark glyph-quality coverage 为 0，不能伪造通过 |

## 5. Good / Base / Bad Cases

- Good：`AveMujica` 在换列前形成一个 sideways run，渲染时整体旋转。
- Good：`そうだねーー` 的两个 `ー` 都是独立 `transformed-sideways` item，方向不受句尾上下文影响。
- Good：`真的吗?！」` 形成一个 `terminal-punctuation` tate-chu-yoko，随后单独布局 `」`。
- Base：单个 `N` 保持直立；单个全角 `？` 使用字体直立形态。
- Bad：把 `～` 映射成 `︴`，会改变波形语义并产生短而怪异的 glyph。
- Bad：先做 `! -> ︕`、`? -> ︖`，再尝试识别 `!?`；此时组合信息已经丢失。
- Bad：用 benchmark GT 或方向诊断重排 `translatedColumns`。
- Bad：把 OCR 输出 `_lll` 当成竖线序列并增加重复字符特判；这会把 OCR 语义错误泄漏进排版规则。

## 6. Tests Required

- `tests/pipeline/typeset/verticalOrientation.test.ts`：Unicode 值、grapheme、wave/长音符、Latin/digit、四类双标点及三连负例。
- `tests/pipeline/typeset/fontFit.test.ts` 与 `typesetGeometry.test.ts`：source advance、换列、禁则和 debug box 无回归。
- `tests/benchmark/glyph-quality.test.ts`：旧日志 coverage=0、run 被拆分时明确失败。
- 运行 `npx tsc --noEmit --pretty false`、`npm run test`、`npm run build`、严格 fixture audit、`bench:render` 和 `bench`。
- 字体或 Canvas transform 变化后，人工复核包含 wave、`ー`、Latin run、双标点的 render/overlay。

## 7. Wrong vs Correct

### Wrong

```typescript
const chars = [...text.replace(/\s+/g, "")];
ctx.fillText(CJK_H2V.get(raw) ?? raw, x, y);
```

### Correct

```typescript
const items = tokenizeVerticalText(text);
for (const item of items) {
  renderVerticalGlyph(ctx, item, centerX, centerY, fontSize, "fill");
}
```
