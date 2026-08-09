# GigaViewer `ttb + baku` 调研

- 调研日期：2026-08-09
- 触发页面：<https://comic-gardo.com/episode/10044607041209439606>

## 结论

1. `readingDirection: "ttb"` 是 GigaViewer 的纵向连续阅读方向（top-to-bottom），不是漫画题材、颜色或制作来源的分类。
2. `choJuGiga: "baku"` 是图片交付/还原模式，不是纵向漫画标记。公开样本中，传统横向翻页漫画与纵向滚动漫画都使用 `baku`。
3. Comic Gardo 这个样本属于明确标注的“タテ読みフルカラー”。内容在阅读语义上是一条连续长画布，但交付时被等高切成 146 张 `720×703` 图片；这些文件是传输/渲染分块，不是编辑意义上的页面。
4. 页面不提供可见分页，是因为纵向滚动及其连续空间本身就是作品版式。结合通用 Web 图片加载原则推断，固定高度切片主要服务文件交付、按需加载、移动设备内存和 DRM；把它们显示成页会把技术边界误当成作品边界。

## 一手来源

### GigaViewer 的产品语义

Hatena 官方将 GigaViewer 描述为出版社用漫画 Viewer，并明确列出：

- PC / 手机支持；
- 稳定显示速度；
- 纵向阅读与横向阅读；
- DRM。

来源：

- <https://hatena.co.jp/solutions/gigaviewer>
- <https://hatena.co.jp/press/release/entry/2017/06/27/153000>

因此 `ttb` 应理解为 Viewer 的阅读方向；`baku` 更接近 DRM/图片交付层。不过 Hatena 没有公开 `choJuGiga` 字段或 `baku` 名称的正式规范。

Comic Gardo 当时公开的 GigaViewer 前端代码把方向枚举定义为 `rtl`、`ltr`、`ttb`；只有前两者属于 horizontal，`ttb` 使用单列布局并绕开左右书页对齐逻辑：

- <https://cdn.comic-gardo.com/js/5808.9b61e08103a57d329bef.chunk.js>

哈希资源可能随部署变化；这里仅记录 2026-08-09 可复核的实现证据。

### 纵向漫画不是“普通分页漫画竖着摆”

集英社官方把纵向漫画描述为随智能手机普及、通过纵向滚动阅读的全彩数字漫画，并强调读者按从上到下的单一路径阅读：

- <https://www.shueisha.co.jp/pickup/23807/>

集英社旗下文章还展示了两项版式特征：气泡位置会按滚动中的视线移动设计；不受传统页面高度限制的纵向空间本身可用于表现空间和节奏：

- <https://wpb.shueisha.co.jp/news/entertainment/20221225-118087/>

`ttb` 也不保证作品是“原生 Webtoon”。少年 Jump+ 的官方纵向彩色版样本明确说明，既有横读漫画会被重新纵向编排、部分加笔并上色，而其公开清单同样是 `ttb + baku`：

- [《株式会社マジルミエ タテカラー版》](https://shonenjumpplus.com/episode/17107094910082444813)
- [《怪獣8号 タテカラー版》](https://shonenjumpplus.com/episode/17107094910082443620)

另有原生纵向作品，例如 [《タテの国》](https://shonenjumpplus.com/episode/10834108156642491399)；所以 `ttb` 覆盖原生纵读、既有作品纵向重排、单列 Web 漫画等多种来源与题材。

### 长画布可以按固定像素切成文件

Clip Studio Paint 官方 Webtoon 文档说明：Webtoon 作品为纵向滚动优化，而非逐页观看；导出时可以把纵向长画布按指定像素高度切成多个 JPEG/PNG 文件。多页工程还可以先连成一张连续图，再重新按固定高度切开：

- <https://help.clip-studio.com/en-us/manual_en/540_comic/Webtoons.htm>
- <https://tips.clip-studio.com/en-us/articles/4001>

这证明“创作/阅读上连续，文件上分片”是标准 Webtoon 工作流。没有证据证明 Comic Gardo 一定使用 Clip Studio，但它的清单形态与这套工作流一致。

## 公开页面清单抽样

以下数据来自各页面公开 HTML 中的 `#episode-json[data-value]`，于 2026-08-09 读取：

| 页面 | direction | mode | main 项 | 主要尺寸 | 页面显示 |
| --- | --- | --- | ---: | --- | --- |
| [Comic Gardo：姉の引き立て役…第2话](https://comic-gardo.com/episode/10044607041209439606) | `ttb` | `baku` | 146 | `720×703` × 146 | タテに読みます；作品标注タテ読みフルカラー |
| [Comic Gardo：天下の大悪人に転生した少年…](https://comic-gardo.com/episode/12207421983917680273) | `rtl` | `baku` | 12 | `1125×1600` × 12 | 普通横向翻页漫画 |
| [となりのヤングジャンプ：魔界のオッサン 第217话](https://tonarinoyj.jp/episode/13932016480028987326) | `ttb` | `baku` | 1 | `800×1133` × 1 | タテに読みます |
| [サンデーうぇぶり：史上最強の弟子ケンイチ2 第1话](https://www.sunday-webry.com/episode/12207421983473064570) | `rtl` | `baku` | 50 | `1426×2048` × 50 | ヨコに読みます |
| [少年ジャンプ＋：阿波連さんははかれない 第1话](https://shonenjumpplus.com/episode/13932016480028799982) | `rtl` | `baku` | 20 | `822×1200` × 20 | ヨコに読みます |
| [くらげバンチ：今日から始める幼なじみ 第1话](https://kuragebunch.com/episode/3269632237305143755) | `rtl` | `baku` | 24 | `844×1200` × 24 | ヨコに読みます |

抽样说明：

- `baku` 同时出现在 `ttb` 和 `rtl`，所以它不代表 Webtoon、全彩或纵向格式。
- `ttb` 既可承载 146 段长条带，也可承载一张普通高度图片，所以它只声明阅读方向；是否为长图要继续看清单数量、尺寸和作品标注。
- Comic Gardo 样本的 146 个 `main` 项全部同尺寸，总逻辑高度为 `102,638px`，这是明显的固定高度纵切结果。
- 同一作品第 86 话公开样本曾使用 124 个统一 `720×875` 条带；MAGCOMI 纵向作品 [《剣の王国》](https://magcomi.com/episode/10834108156766293195) 则使用约 `690×4358` 的长条，Jump+ 纵向作品也存在 1,000–3,000px 的多种高度。不存在统一的“逻辑页高度”，进一步说明这些是交付分片。

## 为什么没有可见分页

### 可以直接确认的事实

- 作品名称明确标注“タテ読みフルカラー”，Viewer 也显示“タテに読みます”。
- 146 张资源无缝组成连续内容，资源边界会穿过文字和气泡；它们不是经过编辑挑选的自然分页点。
- 官方 Webtoon 工具允许按固定像素高度机械切分长画布，因此文件边界不保证避开字符或分镜。

### 工程推断

- 分片允许 Viewer 只准备视口附近的图片，避免首次打开就下载和解码约十万像素高的完整章节。通用 Web 性能资料也建议对视口外图片按需加载，以降低首屏时间、带宽和移动设备内存占用：<https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Lazy_loading>。
- 固定尺寸分片便于 CDN 缓存、失败重试以及逐片执行 `baku` DRM 变换。
- 703px 的具体高度为何被选中，没有找到 Hatena 或 Comic Gardo 的一手说明；不能把“性能/DRM”当作该数值的已证实来源。

## 对 Shinobu Translator 的含义

当前实现把每个 `main` 清单项映射为独立 `pageIndex`，并单独准备 `File`：

- [`gigaViewerManifest.ts`](../../apps/extension/src/content/readerEngines/gigaViewerManifest.ts)
- [`gigaViewer.ts`](../../apps/extension/src/content/readerEngines/gigaViewer.ts)

这对 `rtl` 的真实页面成立，但对 Comic Gardo 这类 `ttb` 固定条带不成立。修复时应把“清单项”和“逻辑翻译页”拆成两个概念；对连续条带使用带上下文重叠的窗口处理，再把结果裁回投影分片。
