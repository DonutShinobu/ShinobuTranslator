# Bibibi / ComiciViewer 预读取调查（2026-08-07）

调查对象：

- 指定章节：[《超かぐやメシ！》0话](https://bibibi-comic.com/episodes/7e06f5b186c99)
- 对照章节：[《マルチバース彼女》第2话](https://bibibi-comic.com/episodes/387904af90683)
- 对照章节：[《さいつよ☆悪役令嬢》第1话](https://bibibi-comic.com/episodes/39dfdbd183592)
- 额外对照：[《別世界ガール》第1话](https://bibibi-comic.com/episodes/3fc263ee98e51)

调查阶段只读；未保存或提交作品图像。

## 结论

可以像 Pixiv 适配一样提前读取并排队翻译，而且不需要模拟翻页。对这些公开章节，章节 HTML 直接给出 `data-comici-viewer-id` 和 `data-api-domain="/api"`；同源接口 `GET /api/book/contentsInfo` 接受页范围并返回 `totalPages`、所有页的短期签名图片 URL、尺寸、顺序和 4×4 拼图置换。官方 viewer 初始化时先取当前页附近的小范围元数据，随后立即异步请求 `page-from=0&page-to=<totalPages>`，所以“必须翻页才开始翻译”来自现有适配只捕获已挂载 Canvas，而不是站点直到翻页才提供后续页面数据。[章节 HTML](https://bibibi-comic.com/episodes/7e06f5b186c99) [viewer.js](https://bibibi-comic.com/js/viewer/viewer.js)

采用的引擎读取链路是：从 `#comici-viewer` 读 viewer ID 和 API domain，取完整 `contentsInfo`，按正文页顺序逐页下载签名 JPEG，按返回的 `scramble` 在离屏 Canvas 复原，再进入既有 OCR/翻译 FIFO。可见页仍用 Comici Canvas 上方投影显示译图；整章读取只替换“输入生产”路径。

这不是一个 selector 小修，而是当前已确认设计范围的一次显式扩展。现有设计把“解析阅读器私有 API、CDN 协议或隐藏页面资源”和“整章翻译”列为范围外；若产品决定支持预读，应先更新该范围，再实现下面的可选章节源能力。[现有通用设计](./continuous-translation-reader-engines.md)

## 实施状态

本轮已按上述证据落地：Comici 仍由阅读器结构指纹和引擎会话识别，不按 Bibibi URL 匹配；会话把整章发现、签名刷新、下载、4×4 解扰和 Canvas 投影隐藏在统一阅读模式接口后。Pixiv 与 Comici 现在共用“翻译当前页 / 翻译全部 / 逐页进度 / 失败重试 / 原译图切换”控制器，旧的“翻页后自动捕获可见 Canvas”产品入口及其按钮已移除。

## 与仓库现状、Pixiv 的对照

| 能力 | Pixiv 阅读模式 | 当前 Comici 连续翻译 | Bibibi 可新增能力 |
| --- | --- | --- | --- |
| 章节身份 | URL 中 artwork ID | `viewerId + origin + pathname` | 保持现有 `contextKey` |
| 完整页发现 | `/ajax/illust/{id}/pages`，失败时读取 preload data | 无；只读当前 `readVisibleSpread()` | `contentsInfo(0,totalPages-1)` |
| 输入 | 可直接翻译的原图 URL | 当前可见、已解扰的 Canvas 快照 | 签名 JPEG + `scramble`，先解扰为 `File` |
| 调度 | 用户点击“翻译全部”后逐页串行 | 已移除产品入口 | 用户点击“翻译全部”后逐页下载、解扰、翻译 |
| 非可见结果 | `PhotoStateStore` 按 URL key 保留 | 已移除产品入口 | `PhotoStateStore` 按引擎章节/页身份保留 |
| 显示 | 替换当前 Pixiv `<img>` | Canvas 上方独立投影 `<img>` | 保持投影，不替换阅读器 Canvas |

具体源码证据：

- [`pixiv.ts`](../../apps/extension/src/content/adapters/pixiv.ts) 第 21–80、243–390 行从 artwork ID 调用 `/ajax/illust/{id}/pages`，校验 `0..pageCount-1` 并缓存完整发现结果。
- [`readingModeController.ts`](../../apps/extension/src/content/core/reading/readingModeController.ts) 第 235–349 行在“翻译全部”后顺序消费全部 URL；第 351–392 行把每页作为 `remote-image` 交给现有图片翻译执行。
- [`contracts.ts`](../../apps/extension/src/content/core/continuous/contracts.ts) 第 17–45 行只定义 DOM 页面表面和 `readVisibleSpread()`，没有章节目录或非可见页源。
- [`comici.ts`](../../apps/extension/src/content/readerEngines/comici.ts) 第 69–104 行明确要求页槽同时具备 `mode-rendered`、Canvas 和可见几何；所以未翻到的页不会进入翻译链路。
- [`continuousTranslationController.ts`](../../apps/extension/src/content/core/continuous/continuousTranslationController.ts) 第 434–461 行只捕获稳定的可见跨页；第 555–648 行已有可复用的严格串行 FIFO、失败隔离和 artifact 生命周期。
- [`pageSourceResolver.ts`](../../apps/extension/src/content/core/continuous/pageSourceResolver.ts) 第 82–123 行只会直接导出 Canvas，否则降级为可见标签页截图；它不能取得尚未显示的页。
- [`imageDownloader.ts`](../../apps/extension/src/background/images/imageDownloader.ts) 第 479–620 行已经能依据可信 sender 文档 URL 计算 Referer，并临时安装 DNR Referer 规则下载远程图片；Bibibi 的签名 JPG 可复用这条能力，但解扰必须发生在图片翻译执行之前。

因此，手动翻页才开始翻译的直接原因已经定位：站点在初始化时提供了全章目录，但 ShinobuTranslator 当前 Comici Adapter 只把“已渲染且当前可见的 Canvas”暴露给通用层。Pixiv 的完整页发现不能原样复用，因为 `UrlTarget` 只有 URL，而 Comici 的 URL 指向 4×4 打乱后的短期签名 JPEG；Pixiv 也替换 `<img>`，Comici 必须继续走 Canvas 上方投影。

## 页面和接口证据

指定章节 HTML（2026-08-07 抓取）包含：

```html
<div id="comici-viewer"
  data-comici-viewer-id="c83aad1f54d65901edd076dfbb099d24"
  data-api-domain="/api"
  data-member-id=""
  data-h-direction="rtl"
  data-use-prev-next-js="1"
  data-first-episode-id="7e06f5b186c99">
</div>
```

来源：[指定章节 HTML](https://bibibi-comic.com/episodes/7e06f5b186c99)。Next.js 集成 bundle 也明确以 React prop `viewerId` 写入 `data-comici-viewer-id`，加载 `/js/viewer/viewer.js`，脚本完成后调用 `window.comiciViewer.init(true)`。[集成 bundle](https://bibibi-comic.com/_next/static/chunks/00ke5jr8o3rdh.js)

`viewer.js` 从 dataset 建立 API host：

```js
Wt.viewerId = attr("comici-viewer-id") || dataset.comiciViewerId;
let apiDomain = dataset.apiDomain;
apiDomain.startsWith("/")
  ? Wt.domain = location.href.split("/")[2] + apiDomain
  : Wt.domain = apiDomain;
```

内容接口 URL 构造函数（变量名按压缩文件）：

```js
function ee(pageFrom, pageTo, contentId) {
  return protocol + Wt.domain
    + "/book/contentsInfo?user-id=" + Wt.memberJwt
    + "&comici-viewer-id=" + Wt.viewerId
    + "&page-from=" + pageFrom
    + "&page-to=" + pageTo
    + (contentId ? "&contentId=" + contentId : "");
}
```

来源：[viewer.js](https://bibibi-comic.com/js/viewer/viewer.js)。指定章节可直接请求：

```text
https://bibibi-comic.com/api/book/contentsInfo?user-id=&comici-viewer-id=c83aad1f54d65901edd076dfbb099d24&page-from=0&page-to=6
```

返回结构示例（签名省略）：

```json
{
  "totalPages": 12,
  "scrollDirection": "横",
  "spreadDesignation": 1,
  "result": [{
    "imageUrl": "https://viewer.bibibi-comic.com/book/c83aad.../master-...-01.jpg?Expires=...&Signature=...&Key-Pair-Id=...",
    "scramble": "[13, 0, 7, 10, 1, 8, 12, 5, 15, 14, 2, 9, 11, 4, 6, 3]",
    "sort": 0,
    "width": 850,
    "height": 1200,
    "expiresOn": 1786095637000
  }]
}
```

`page-to` 是包含端点：`0..0` 返回 1 页，`0..1` 返回 2 页，`0..6` 返回 7 页。公开章节接口在无 Cookie、无 Authorization、无 Referer 的 PowerShell 请求中返回 200；随机无效 viewer ID 返回 404。该结论只适用于本次验证的公开可读章节，不能外推到付费或会员章节。

补充范围测试中，`0..totalPages` 与 `0..totalPages-1` 都返回完整正文集合；12、32、40 页三个公开样本分别得到 12、32、40 个连续 `sort`。因此可以按官方脚本直接请求 `0..totalPages`，也可以按小窗口分段取元数据。

访问控制边界也在匿名页面上得到验证：

- [《戦闘アンドロイド、平和な街に誤転送される》第8话①](https://bibibi-comic.com/episodes/0508aaeeb6b5a) 的服务端数据为 `hasAccess:false`，页面没有 `#comici-viewer` / `data-comici-viewer-id`。
- [《だから肉まんを売る》第10话](https://bibibi-comic.com/episodes/02b57c360b73c) 同样为 `hasAccess:false`，页面没有 viewer ID。

所以建议的预读链路只应在页面本来就挂载公开阅读器时启用；不能从受限章节页面取得 ID 时必须正常退出或回退。

## 多章节对照

以下均通过各章节 HTML 提取 viewer ID，再调用相同 `contentsInfo` 接口；每次请求范围均为 `0..6`：

| 章节 | viewer ID | 总正文页 | 返回页 | 方向 / 跨页 | 首图尺寸 |
| --- | --- | ---: | ---: | --- | --- |
| 超かぐやメシ！ 0话 | `c83aad1f54d65901edd076dfbb099d24` | 12 | 7 | 横 / 1 | 850×1200 |
| マルチバース彼女 第2话 | `963227a47ce414d20af41fc6c2960305` | 46 | 7 | 横 / 2 | 852×1200 |
| さいつよ☆悪役令嬢 第1话 | `3db6b2a615705b7969ed8f33307f48fd` | 25 | 7 | 横 / 2 | 1353×1920 |
| 別世界ガール 第1话 | `bb82603d8b2fc215497fad7125a94a7f` | 60 | 7 | 横 / 2 | 852×1200 |

四个样本都返回同一字段集合、`viewer.bibibi-comic.com/book/<viewerId>/...jpg` 路径、三项 CloudFront 查询签名和长度为 16 的 `scramble` 字符串。来源分别为上列四个章节页及其由页面 viewer ID 构造的同源 `contentsInfo` 请求。

另两条真实浏览器网络轨迹也显示同样的“两阶段”模式：

- [Cross Dressing Theater 特别公开](https://bibibi-comic.com/episodes/b1c29660c751f)：`totalPages=11`，先请求 `0..1`，再请求全章 `0..11`。
- [百貨の魔法 第1话](https://bibibi-comic.com/episodes/263b3bac760d5)：`totalPages=36`、`spreadDesignation=2`，先请求 `0..1`，再请求全章 `0..36`。

这些轨迹与 `viewer.js` 使用 `contentsInfo(0,totalPages)` 的实现一致；接口会截断超出正文末尾的包含端点。本实现若自行请求可使用更严格的 `0..totalPages-1`。

## 官方加载与渲染机制

`viewer.js` 的 `loadData()` 对新会话做两阶段读取：[viewer.js](https://bibibi-comic.com/js/viewer/viewer.js)

```js
let from = currentPage - 1;
let to = from + 2;

fetch(contentsInfo(Math.max(from, 0), to))
  .then(initial => {
    Object.assign(Wt.navigation, initial);
    // 预取当前跨页附近的 Image
    // 非 iframe：随后后台取得整章元数据
    fetch(contentsInfo(0, Wt.navigation.totalPages))
      .then(all => {
        Wt.navigation.result = all.result;
        Pr(currentPage);
      });
  });
```

默认 `preloadPages: 6`。`Pr(currentPage)` 只让当前页附近的页进入 `Er()` 图片加载/Canvas 渲染，并用 `Dr()` 清空远处 Canvas。因此 DOM 中固定页槽可以提前存在，但正文 Canvas 只在邻近当前页时挂载；依赖 `mode-rendered` Canvas 的翻译器自然要等用户翻页。[viewer.js](https://bibibi-comic.com/js/viewer/viewer.js)

图片不是可直接 OCR 的原页：viewer 建立 `crossOrigin="anonymous"` 的 `Image`，随后在 `Mr()` 中把源图按 4×4 分块重排到 Canvas。核心逻辑为：[viewer.js](https://bibibi-comic.com/js/viewer/viewer.js)

```js
const cols = 4, rows = 4;
const sourceCells = permutation(cells, page.scramble);
for (let outX = 0; outX < cols; outX++) {
  for (let outY = 0; outY < rows; outY++) {
    const [srcX, srcY] = sourceCells[index++];
    ctx.drawImage(image,
      tileW * srcX, tileH * srcY, tileW, tileH,
      tileW * outX, tileH * outY, tileW, tileH);
  }
}
```

这里的源坐标表和目标坐标都按“列在外、行在内”的列主序遍历。实现时必须复用等价的 4×4 复原；把目标索引按行主序解释，或直接把签名 JPEG 送 OCR，都会得到 4×4 错位图。

本轮还做了输入等价性验证：从指定章节 API 取 `sort=7` 的原始 JPEG 与 `scramble`，按上述官方算法离屏复原，再与阅读器翻到该页后 DOM `slot 7` 的已渲染 Canvas 比较。两者输出尺寸均为 `848×1200`，64-bit dHash 汉明距离为 `0`。这直接证明“API 下载 + 解扰”可以在用户翻页前构造与现有 Canvas 捕获相同的 OCR 输入；测试过程中未保存或提交作品图像。

## 签名、跨域和有效期

- 图片 URL 查询键为 `Expires`、`Signature`、`Key-Pair-Id`，同时 JSON 提供毫秒时间戳 `expiresOn`；重复请求会获得新的短期签名。[contentsInfo 示例](https://bibibi-comic.com/api/book/contentsInfo?user-id=&comici-viewer-id=c83aad1f54d65901edd076dfbb099d24&page-from=0&page-to=1)
- 一次 2026-08-07 09:08:37 UTC 的响应给出 09:38:37 UTC 的 `expiresOn`，实测签名窗口约 30 分钟；这只是当次站点配置，应始终以返回值为准。
- viewer 在使用 URL 前以 `expiresOn - 30000`（默认 `expireBuffer: 30000`）判断过期，过期则要求重新初始化。[viewer.js](https://bibibi-comic.com/js/viewer/viewer.js)
- 图片响应带 `Access-Control-Allow-Origin: *`，允许匿名 CORS Canvas；但实测 GET 必须携带 `Referer: https://bibibi-comic.com/...`：正确 Referer 为 200，缺失或 `https://example.com/` 为 403。浏览器页面上下文的普通跨域图片请求会自然携带站点 Referer；后台/扩展网络层若剥离 Referer，需要显式处理或改为注入页面上下文 fetch。
- `contentsInfo` 请求本身是同源，不依赖 Referer。付费/会员内容的 `user-id`、`data-member-jwt`、`data-member-id-token` 分支存在于 viewer，但本调查未验证，不能假设匿名可读。

## 可复核命令

提取章节页 viewer 配置：

```powershell
$h = (Invoke-WebRequest -UseBasicParsing `
  'https://bibibi-comic.com/episodes/7e06f5b186c99').Content
[regex]::Matches($h, 'data-[a-z0-9-]+="[^"]*"') |
  ForEach-Object Value |
  Where-Object { $_ -match 'viewer|api|episode|direction' }
```

读取范围元数据：

```powershell
$u = 'https://bibibi-comic.com/api/book/contentsInfo' +
  '?user-id=&comici-viewer-id=c83aad1f54d65901edd076dfbb099d24' +
  '&page-from=0&page-to=6'
$j = Invoke-RestMethod $u
$j.totalPages
$j.result | Select-Object sort,width,height,scramble,expiresOn,imageUrl
```

验证图片 Referer 限制（URL 每次从 API 新取，避免使用过期签名）：

```powershell
$img = $j.result[0].imageUrl
Invoke-WebRequest -UseBasicParsing $img `
  -Headers @{ Referer = 'https://bibibi-comic.com/' }
```

调查时资源指纹，便于后续判断站点是否换版：

| 资源 | 长度 | Last-Modified | SHA-256（UTF-8 文本） |
| --- | ---: | --- | --- |
| `/js/viewer/viewer.js` | 168,938 | 2026-08-07 02:31:26 GMT | `f010027e8ddcf42cf77b7fecb12059762050fbd9498063493b05f21c2be77b6c` |
| `/_next/static/chunks/00ke5jr8o3rdh.js` | 35,578 | 2026-08-07 02:35:40 GMT | `86d74ffb23cb6c28b8d3b6a48954b0bd40bca396394be1c761ea833ea794331f` |

## 适配边界

1. 不把 viewer ID 或签名 URL持久化为长期身份；签名会过期，viewer ID 以当前章节 DOM 为准。
2. 预取窗口应有并发、内存和队列背压；“一次获得整章元数据”不等于“同时下载并 OCR 60 页”。
3. 站点会清除远端 Canvas，预翻译结果应由扩展自己的页身份/缓存持有，页面回到可见时再投影。
4. 用户阅读方向、单双页和特殊广告页仍应沿用现有 DOM 适配语义；接口的 `sort` 是正文页序号，不能直接替代带特殊页槽的 DOM ordinal。
5. 若接口、字段或 scramble 逻辑变化，应回退到当前 Canvas 惰性捕获路径，而不是阻断翻译。

## 建议架构

建议扩展连续翻译框架，而不是把 Comici 硬塞进 `SiteAdapter` / `ReadingModeController`：

```text
ComiciReaderEngineSession
  ├─ readVisibleSpread()                 现有 Canvas 路径，继续作为回退与投影依据
  └─ createChapterSource()?              新增可选能力
       ├─ list(signal)                    返回正文页 identity/sort，不返回特殊页
       └─ acquire(page, signal)           刷新签名、下载、4×4 解扰，返回 File

ContinuousTranslationController
  ├─ visible producer                    现有稳定跨页捕获
  ├─ chapter producer                    当前页优先、有限前瞻、上下文取消
  └─ freeze → fingerprint → OPFS → FIFO → local pipeline → result artifact
```

建议的通用契约只暴露“可枚举、可冻结的逻辑正文页”，不要把 `scramble`、CloudFront 签名或 Comici 字段泄漏到通用控制器。示意：

```ts
type ReaderChapterPage = {
  identity: ReaderPageIdentity;
};

interface ReaderChapterSource {
  list(signal: AbortSignal): Promise<readonly ReaderChapterPage[]>;
  acquire(page: ReaderChapterPage, signal: AbortSignal): Promise<File>;
}

interface ReaderEngineSession {
  // existing members...
  createChapterSource?(): ReaderChapterSource | null;
}
```

`acquire()` 的网络依赖应注入 Adapter；下载、存储和取消仍由扩展拥有的 Port 承担。这样通用层只负责顺序、背压、去重、artifact 和错误语义，Comici 层独占 API schema、签名刷新与解扰算法。

### 推荐执行顺序

1. 只有用户显式开启连续翻译后才启动整章发现；页面仅被检测到时不下载全章。
2. 从当前 session 读取可见正文页，令当前跨页抢占并先入队；随后按 API `sort` 产生其余页。目录可以全量驻留内存，但同时冻结的图片应有小型有界窗口，例如 2–4 页。
3. 每次 `acquire()` 前检查 `expiresOn - 30s`。临近过期或图片 403 时只刷新一次 `contentsInfo`，以新的 `sort -> imageUrl` 继续；不要长期保存签名 URL。
4. 通过现有 background 图片下载器获取字节，使它根据当前章节 sender 设置 Bibibi Referer。初版可复用既有 base64 消息；若整章性能不理想，再增加“background 下载后直接写 artifact”的二进制路径，避免大图多次 base64 复制。
5. 严格校验 `scramble` 是 `0..15` 的无重复排列，宽高为合理正整数，`sort` 唯一连续，URL 为 HTTPS 且属于当前 Comici provider 允许的图片主机/路径；然后在离屏 Canvas 按官方 4×4 算法复原并导出 `File`。
6. 立即计算内容指纹并写入现有扩展域 artifact store；队列只持 artifact ref。翻译成功后沿用现有结果 artifact 与投影机制。
7. API 不可用、schema 不合法、鉴权未知、URL 刷新失败或解扰失败时，关闭该 session 的章节预读能力并回退到现有可见 Canvas 捕获，不影响手动翻页后的连续翻译。

### 页面身份与 DOM 映射

API 的 `sort` 是正文页 `0..totalPages-1`；当前 Comici `pageIndex` 是 `#xCVPages > .-cv-page` 的 DOM ordinal。二者不能直接等同：阅读器可能在正文前插入 `mode-empty`，并在正文后插入 `mode-pr`、`mode-good`、`mode-last` 等特殊页。

预读实现需要为正文建立稳定映射。第一方 `viewer.js` 为每个正文页槽创建 `.x-cv-page-retry-btn`，而特殊页不属于该正文循环；可把“正文槽在所有正文槽中的 ordinal”作为 API `sort`，同时继续排除特殊 class。此映射应以合成 DOM 夹具覆盖 `spreadDesignation=1/2`、前置空页和尾部特殊页，不能用样本页数或固定 `+1/-1` 偏移。

如果暂不愿改变现有 `ReaderPageIdentity.pageIndex` 语义，也可以新增单独的 `sourcePageIndex`；但预取结果与可见投影最终必须共享同一个逻辑正文 key，否则单双页切换和前置空页会造成重复翻译或无法投影。

## 限制、风险与验证门槛

- **只证明了 Bibibi 站内稳定性。** 多部漫画、多个章节和不同页数的结构一致，但这不是 ComiciViewer 对所有客户站点的公开兼容承诺。首版宜把远程预读作为 `bibibi-comic.com` provider capability；通用 Comici Canvas 路径继续跨站。
- **接口是第一方运行时接口，不是文档化公共 API。** 任何字段或 URL 变化都必须安全降级；不要让整章发现成为基础连续翻译的启动前置条件。
- **不能扩大访问权。** 匿名 `hasAccess:false` 页面没有 viewer 节点。只处理当前页面已经得到的 viewer ID；不枚举章节 ID、不猜 viewer ID、不请求用户尚未获权的内容。
- **登录/购买内容未验证。** `viewer.js` 存在 `memberJwt`、`memberIdToken` 和 `window.comiciAuth` 分支，但本调查没有使用账户。首版应明确只保证公开/试读章节；后续验证鉴权时不得记录或持久化 token。
- **签名短效。** 30 分钟足以下载一个小前瞻窗口，却不足以把整章 URL 排队后慢慢翻译。必须按获取时机刷新，或先冻结为 extension-owned artifact。
- **带宽与存储。** “拿到全章元数据”不等于同时下载 60 张大图。有界 acquisition 窗口、OPFS 配额错误和用户关闭/章节切换时的取消清理都是完成条件。
- **安全边界。** `data-api-domain` 与响应 `imageUrl` 来自宿主页 DOM/响应，不能无条件交给拥有 `<all_urls>` 权限的 background。初版限制 metadata 为同源 `/api/book/contentsInfo`，图片为 provider 允许的 HTTPS host/path；拒绝私网、非 HTTP(S)、重定向越界与异常数量/尺寸。
- **日志隐私。** 诊断日志只能记录去查询参数的主机/路径和页号，不能记录签名、JWT、Authorization 或完整图片 URL。

最低自动化覆盖建议：

1. `contentsInfo` parser：完整页、乱序/重复 sort、缺字段、超大页数、非法 URL。
2. 4×4 解扰：使用纯色编号合成图验证 16 个 tile 全排列，不使用作品像素。
3. 签名刷新：临近过期、首次 403 后刷新成功、二次失败降级。
4. 身份映射：单页/双页、前置 empty、PR/good/last 混排、横竖切换。
5. 控制器：当前页优先、有限 acquisition 窗口、严格 FIFO、可见捕获与预取去重、60 页模拟章节不线性占用 content Blob 内存。
6. 生命周期：关闭开关、contextKey 变化、document 销毁、background 重启和 OPFS 配额不足。
7. 真实页只保留结构、请求状态和 hash；不得保存或提交漫画图像。

## 最终判断

**可行，且站点证据强。** 对 Bibibi 的公开可读章节，首屏即能获得 viewer ID，官方脚本自身也会立即取得整章 `contentsInfo`；无需模拟点击或后台翻页。实现难点不是“找出后页”，而是把短期签名、Referer、4×4 解扰、正文页身份映射和 bounded prefetch 纳入现有 artifact/FIFO/投影架构。

建议的产品形态是：保留现有“开启连续翻译”开关，开启后优先翻译当前跨页，并在后台按正文顺序预读和翻译后续页；已完成的不可见结果存于当前 document 的扩展 artifact store，用户翻到该页时直接投影。元数据或解扰路径失效时自动回退到当前“翻到才捕获”的行为。
