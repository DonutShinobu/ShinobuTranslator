# 阅读模式：GigaViewer 引擎规范

在实现或修改 GigaViewer 检测、清单解析、页面映射、图片还原、observer 或真实页面回归时读取本文。通用阅读模式沿用现有 `ReaderEngineAdapter`、`ReadingModeController` 和“翻译当前页 / 翻译全部”语义。

基准页面：<https://www.sunday-webry.com/episode/12207421983473064570>

## 1. 强指纹

适配器不使用域名白名单。只有以下运行态证据同时成立才返回 `confidence: 'strong'`：

```text
#episode-json[data-value]
AND readableProduct.pageStructure.pages 可解析
AND section.js-viewer
AND .js-viewer-content > .js-page-area
AND 过滤特殊槽位后的正文槽数量等于清单 main 页数量
```

脚本 URL、CDN 主机和站点品牌只能作为诊断证据，不能单独触发适配。页面尚未完成 hydration 时检测可以暂时失败；全局 observer 会在结构或 `data-value` 变化后重试。

## 2. 阅读上下文

```text
contextKey = giga-viewer
  + product.typeName
  + product.id
  + product.imageUrisDigest
  + location.origin + location.pathname
```

同一 DOM 被下一话复用时，只要产品身份、图片摘要或地址变化，就必须销毁旧会话并重绑。页面准备过程中如果上下文改变，旧会话不得继续交付图片。

## 3. 清单与正文页

- 元数据只读取页面直出的 `#episode-json[data-value]`，不调用私有章节 API。
- 支持 `episode`、`magazine`、`volume` 产品；支持 `rtl`、`ltr`、`ttb` 阅读方向。
- 只把 `pageStructure.pages` 中 `type: "main"` 的项作为翻译单元；`link`、`other`、`backMatter` 等特殊项不占正文 `pageIndex`。
- 每个 `main` 清单项都是一个完整翻译单元。居中跨页不拆分，GIF 取首帧。
- 正文 `pageIndex` 从零连续编号；保留清单 ordinal 仅用于诊断，不用它制造空洞。
- 图片 URL 和 permalink 必须是无用户名密码的 HTTPS URL；尺寸、像素总数和清单长度均有防御性上限。

DOM 映射先从 `.js-viewer-content` 的直接 `.js-page-area` 子节点中过滤 `.page-dummy`、`.js-link-page`、`.js-page-ad` 和 back-matter 槽位，再按顺序与正文清单一一对应。不得根据当前惰性挂载的 Canvas 数量推断正文总页数。

## 4. 图片准备

- `choJuGiga: "baku"`：先绘制完整源图，再按固定 4×4 网格把源 `(column, row)` 转置到目标 `(row, column)`。单格宽高按 `floor(dimension / 32) * 8` 计算，网格外余量保留完整源图像素。
- `choJuGiga: "usagi"`、字段缺失或空值：按原始图片处理。
- 未知模式明确报告不支持，不猜测还原算法。
- GIF 通过解码后重新输出 PNG，以稳定使用第一帧。
- 下载失败后最多重读一次同一上下文清单并重试；上下文已改变时立即失败，交由新会话处理。

测试夹具不得包含作品图像。4×4 还原使用空白 bitmap/canvas 桩验证完整绘制、16 个 tile move、余量和导出格式。

## 5. 当前页与翻译全部

- “翻译当前页”取所有与 `section.js-viewer` 可见矩形存在正面积交集的 `canvas.js-page-image`；双页时两张都进入当前集合。
- “翻译全部”直接按正文清单准备尚未显示的页面，不后台翻页。
- “翻译全部”最多 200 个正文页；超限时显示正文页数与上限，并保留“翻译当前页”。
- 未知阅读方向、未知图片模式和元数据失效都返回明确的 discovery 错误。

## 6. 投影与监听

- 译图以 `[data-mt-reading-projection]` 绝对定位在对应正文槽内，不替换阅读器 Canvas。
- 投影矩形取 Canvas 相对槽位的局部坐标；缩放、滚动、方向切换和全屏只更新几何，不改变页面身份。
- session 监听正文容器的结构、class/style/Canvas 尺寸、滚动和 transition，并监听全屏与 document 可见性。
- observer 必须忽略扩展生成的 `data-mt-*` 节点，防止自身投影触发循环。

## 7. 真实页面回归

已用于结构与构建后扩展挂载验证的页面：

- Sunday Webry：<https://www.sunday-webry.com/episode/12207421983473064570>，`rtl`，50 个正文页。
- Shonen Jump+：<https://shonenjumpplus.com/episode/13932016480028799982>，`rtl`，20 个正文页。
- Kurage Bunch：<https://kuragebunch.com/episode/3269632237305143755>，`rtl`，24 个正文页。
- Comic Gardo：<https://comic-gardo.com/episode/10044607041209439606>，`ttb`，146 个正文页。
- Tonari no Young Jump：<https://tonarinoyj.jp/episode/13932016480028987326>，`ttb`，1 个正文页。

真实回归只保存结构、计数、方向、模式、控件挂载状态和错误日志；不保存或提交作品像素。
