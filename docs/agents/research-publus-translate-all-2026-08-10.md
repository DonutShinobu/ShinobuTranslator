# PUBLUS Reader「翻译全部」公开入口研究

- 调查日期：2026-08-10
- 范围：comicブースト（PUBLUS 1.0.5）、マンガBANGブックス（PUBLUS 1.0.7）、BOOK☆WALKER（PUBLUS 2.0.29）
- 目标：在不读取 `window.NFBR`、不注入 Hook、不模拟翻页的边界内，确认能否权威发现试读页序并恢复每一页

## 结论

三个站点都有可独立重放的「翻译全部」入口。此前把 PUBLUS 全量固定为 `unsupported-format` 的两个前提均不成立：

1. PUBLUS 1.x 的配置虽然包在 `{version, data}` 中，但官方 `viewer_image` 运行时包含仅依赖配置文本和固定算法的解包链；不需要读取阅读器堆内状态。解包后的 `configuration.contents` 是权威页序，页面 URL 和分块复原也可以离线确定。
2. PUBLUS 2.x 的 `configuration_pack.json` 已是明文 JSON；权威试读子集就是 `configuration.contents`，不能也不需要遍历配置包的所有顶层键。

| 站点 | 会话入口 | 权威页序 | 页面资源 | 验证结果 |
| --- | --- | --- | --- | --- |
| comicブースト 1.0.5 | `GET /pageapi/viewer/c.php?cid=…` | 解包后的 `configuration.contents` | 1.x 文件名派生 + 32×32 分块复原 | 25/25 页静态发现、资源可取 |
| マンガBANG 1.0.7 | `GET /viewer_api/contents/permission?cid=…` | 解包后的 `configuration.contents` | 1.x 文件名派生 + 32×32 分块复原 | 32/32 页静态发现、资源可取 |
| BOOK☆WALKER 2.0.29 | `GET /trial-page/c?cid=…&BID=…` | 明文 `configuration.contents` | `${file}/${Page.No}.${type}` | 26/26 页静态发现、JPEG 可直接显示 |

这里的“静态”是指只重放阅读器公开发出的授权、配置和图片请求；授权值仍只在当前会话内使用，不应记录或持久化。

## 共同协议入口

三个站点都先通过当前阅读器 URL 中的公开 `cid` 请求一次内容许可，再从返回的 `url` 取得内容包：

```text
当前 viewer URL 的 cid
        │
        ▼
站点 content-check / permission API
        │  返回内容基址 url；部分站点同时建立临时授权
        ▼
<url>/configuration_pack.json
        │
        ▼
configuration.contents       ← 唯一权威阅读顺序/试读子集
        │
        ▼
每个 content 对应的 PageLinkInfoList
        │
        ├─ 2.x：直接拼图片 URL
        └─ 1.x：派生文件名并按 Page 元数据复原分块
```

实现时只遍历 `configuration.contents`。配置包顶层还含有整书元数据或随机键；遍历顶层会把非试读内容误报成“全部”。

## comicブースト：PUBLUS 1.0.5

公开作品页：<https://comic-boost.com/product/01450024>

作品页跳转到同站 `/viewer/viewer.html?cid=…`，页面加载：

- <https://comic-boost.com/viewer/js/viewer_loader_1.0.5_2024-08-09.js>
- <https://comic-boost.com/viewer/js/viewer_image_1.0.5_2024-08-09.js>
- <https://comic-boost.com/viewer/js/config.js>

`config.js` 将内容检查接口配置为 `/../pageapi/viewer/c.php`。在作品页建立的同一临时会话内请求：

```http
GET https://comic-boost.com/pageapi/viewer/c.php?cid=<current-cid>
```

返回 `status`、`url`、`cti`、`lp`、`cty`、`lpd`、`lin`、`bs`；其中公开内容基址是：

```text
https://cdn.comic-boost.com/contents/publus/S0145_ch_021/
```

直接请求 `configuration_pack.json` 得到 `{version:"1.0", data:"…"}`。官方 `viewer_image` 中注册到 `NFBR.a6i.H6f` 的解析器会替换基础 BookLoader 的文本解析步骤：普通配置仍直接 `JSON.parse`，带 `data` 的配置则进入固定的解包步骤，最后再 `JSON.parse`。这条链只接收配置文本和配置标识，不读取当前页、翻页历史或阅读器模型。

独立重放得到：

- `configuration.contents` 共 25 项，索引连续为 1–25；
- `page-progression-direction` 为 `rtl`；
- 每项都能由 `pack[item.file].FileLinkInfo.PageLinkInfoList` 定位到一张 JPEG；
- 每页携带 `Page.NS`、`Page.PS`、`Page.RS`，固定布局块尺寸为 32×32；
- 25 个派生资源全部返回成功，首张离线复原尺寸与 `Page.Size` 的 1024×1456 完全一致。

直接脱离作品页会话调用许可接口会返回未授权，因此适配器必须沿用当前页面的临时凭据，例如 `credentials: "include"`；不应缓存 Cookie 或 `cid`。

## マンガBANGブックス：PUBLUS 1.0.7

原回归页 <https://manga-bang.com/store/books/BT000237294900100101> 当前的 `sample_file_path` 为 `null`，它自己的试读按钮不可用，公开试读 API 也返回 `NOT_FOUND`。同一页面列出的普通卷仍有试读，本次使用：

<https://manga-bang.com/store/books/BT000160980800100101>

站点自己的前端代码给出了入口链：

- `SampleButton` 调用 `useReadBook("sample")`：<https://web2-assets.manga-bang.com/packs/js/7527-ae5c3c0a63bd73a5cebb.js>
- `useReadBook` 选择 `readContentSampleApi`：<https://web2-assets.manga-bang.com/packs/js/4659-c3bbaec4cd8082ffcbad.js>
- API 模块请求 `/api/v1/users/stores/read_content_sample.json?content_id=…`：<https://web2-assets.manga-bang.com/packs/js/5961-ecb2bf86bc4f77916570.js>

因此从商品页进入 viewer 的公开请求是：

```http
GET https://manga-bang.com/api/v1/users/stores/read_content_sample.json?content_id=BT000160980800100101
```

返回的 `url` 指向 `https://web-viewer.manga-bang.com/viewer.html?cid=…`。viewer 加载：

- <https://web-viewer.manga-bang.com/js/viewer_loader_1.0.7_2024-09-04.js>
- <https://web-viewer.manga-bang.com/js/viewer_image_1.0.7_2024-09-04.js>
- <https://web-viewer.manga-bang.com/js/config.js>

其 `config.js` 指向下面的许可接口：

```http
GET https://manga-bang.com/viewer_api/contents/permission?cid=<current-cid>
```

响应的 `url` 是当前试读内容基址，并通过临时 CloudFront Cookie 授权 CDN。适配器只需让许可请求和后续资源请求带上当前会话凭据；不得读取、记录或拼接 Cookie 的值。

该站的配置同样是 1.x `{version, data}` 包装。对 1.0.7 实站配置应用已在 1.0.5 官方运行时定位、并由两站资源交叉验证的确定性协议后：

- `configuration.contents` 共 32 项，与许可响应中的 `lp=32` 一致；
- 索引连续为 1–32，阅读方向为 `rtl`；
- 每项是一张 JPEG，块尺寸为 32×32，并有整数 `NS`、`PS`、`RS`；
- 32 个派生资源全部返回成功，首张复原尺寸与 `Page.Size` 的 948×1340 完全一致。

## BOOK☆WALKER：PUBLUS 2.0.29

KADOKAWA 官方说明页：<https://www.kadokawa.co.jp/topics/16322/>

其中的 BOOK☆WALKER 试读链接进入 `viewer-trial.bookwalker.jp/03/21/viewer.html`，加载：

- <https://viewer-trial.bookwalker.jp/03/21/js/viewer_loader_2.0.29_2025-03-12.js>
- <https://viewer-trial.bookwalker.jp/03/21/js/viewer_image_2.0.29_2025-03-12.js>
- <https://viewer-trial.bookwalker.jp/03/21/js/config.js>

`config.js` 明确配置内容检查服务 `https://viewer-trial.bookwalker.jp/trial-page`、路径 `/c`、浏览器标识后缀 `NFBR` 以及同源存储键 `NFBR.Global/BrowserId`。入口为：

```http
GET https://viewer-trial.bookwalker.jp/trial-page/c?cid=<current-cid>&BID=<current-browser-id>
```

遗漏 `BID` 时服务返回业务状态 400。成功响应的 `url` 是当前内容基址，`auth_info` 提供短期 CDN 查询授权。适配器可以读取官方配置声明的同源 browser-id；这不属于读取 `window.NFBR` 私有对象。授权字段只保留在内存中，资源请求遇到 401/403 时重新调用 `/c`，不得把其值写入日志、测试夹具或持久存储。

该目标的 `configuration_pack.json` 是明文 JSON。权威目录 `configuration.contents` 恰好有 26 项：封面、折页以及 `p-001` 至 `p-024`，阅读方向为 `rtl`。每项按下列字段解析：

```text
item = configuration.contents[i]
page = pack[item.file].FileLinkInfo.PageLinkInfoList[0]
imagePath = item.file + "/" + page.Page.No + "." + item.type
imageUrl = auth.url + imagePath + "?" + auth_info
```

目标中每项恰好一页且类型为 JPEG。26/26 个 URL 均成功加载为 1440×2048 图片。当前 viewer 显示第 3/26 页时，静态入口的 `contents[2]`（`p-001`）缩放后与当前 Canvas 抽样比较：97.44% 像素完全一致，通道平均绝对误差为 0.0245；差异只出现在普通缩放边缘。因此该目标不需要分块解扰。

## PUBLUS 1.x 的可移植部分

1.x 需要移植三个纯算法步骤，但它们不要求越过现有适配边界：

1. 解开 `configuration_pack.json` 的 `data`，得到普通配置对象；
2. 根据 `file-name-version`、content/item/page 元数据和配置中派生出的固定字节表生成真实资源文件名；
3. 根据 `Page.NS/PS/RS`、`BlockWidth/BlockHeight` 和页面尺寸把资源块还原到目标 Canvas。

官方运行时是第一方存在性证据，实站 25/25 和 32/32 重放是协议验证。为了交叉核对算法，还参考了公开实现：

- 配置解包实现：<https://update.greasyfork.org/scripts/451811/1096709/PublusConfigDecoder.js>
- 文件名派生与分块复原实现：<https://update.greasyfork.org/scripts/451814/1159347/PublusPage.js>

这两个社区脚本只能作为移植线索，不能作为站点识别依据；实现应以官方配置字段做严格校验，并用固定的已脱敏元数据测试向量锁住行为。代码不应动态执行或远程加载社区脚本。

### 1.0.5 官方运行时定位

`viewer_image_1.0.5_2024-08-09.js` 是压成一行的混淆脚本；字符串解混淆后可稳定定位以下模块。符号名仅用于审计官方实现，不应成为适配器指纹：

- `Ec_Yi` case 59 注册 `NFBR.a6i.H6f`，替换 BookLoader 的配置文本解析器。它检测 `"data":"`，运行固定 `Progress` 解包链，然后 `JSON.parse`；脚本加载时立即 `enable()`。
- `eceEi` case 56 注册 `NFBR.a6i.R3s`，覆盖页面资源路径生成。三组配置字节逐下标 XOR 得到书级密钥；实际哈希消息是 `page.d7N + "/" + page.fileName`，输出 16 个小写十六进制字符。`Page.No`/目录索引没有额外参与；若 `fileName` 本身是数字，它只通过 `fileName` 参与，移植时不能再附加一次 page index。
- `lCcYi` case 40 注册 `NFBR.a6i.b8F`，解析块参数。它把三组 key 分别折叠为 32 位书级种子，并结合 `page.d7N`、`page.fileName` 字符和、`NS/PS/RS` 产生三个页级种子；同时读取 `DummyWidth/Height` 与 `BlockWidth/Height`。
- `$eyYi` case 62 注册 `NFBR.a6G.b8F`，消费上述种子和块网格，经官方 PRNG/permutation 生成每块的 `srcX/srcY/destX/destY/width/height`。所以 `NS/PS/RS` 不是可直接使用的排列序号。

1.0.7 的实站入口、pack profile、最终资源和复原结果已经验证相同；本次没有逐个给它的混淆函数重新命名。实现应以输入/输出测试向量证明两版兼容，而不是假设 1.0.7 仍保留 1.0.5 的混淆符号。

## 建议的适配边界

可以把 `discoverReadingPages()` 从固定 unsupported 改为两个 fail-closed profile：

### PUBLUS 1.x profile

- 只接受 `{version:"1.0", data:string}`，且纯解包成功；
- 要求 `configuration.contents` 为非空、有序、索引唯一的数组；
- 每个 item 必须能解析到已知图片类型、合法 `Page.Size`、块尺寸和整数 `NS/PS/RS`；
- 许可响应有有效 `lp` 时，必须与发现数量一致；comicブースト 的 `lp` 为空时以 `contents` 为准；
- 任一项解包、URL 派生或复原失败就返回 unsupported/error，不猜文件名、不跳过页面伪装成功。

### PUBLUS 2.x profile

- 只接受明文配置和有效的 `configuration.contents`；
- 第一版先限制为已验证的一项对应一张、`Page.No` 为非负整数、类型为 JPEG/PNG 的固定布局内容；
- 只从 `contents` 查相应 item，不枚举包顶层；
- 授权缺失或刷新失败时明确返回授权错误，不退化为后台翻页收集。

两个 profile 都不需要：

- 访问 `window.NFBR` 或任何堆内模型；
- 注入页面脚本、Hook fetch/XHR/解码器；
- 自动点击、翻页或预加载全部 viewer Canvas；
- 持久化 `cid`、BID、签名参数、CloudFront Cookie 或作品像素。

## 证据边界与后续实现注意点

- 本次确认的是三个具体版本和站点；未来版本应先按脚本版本、配置结构和字段约束重新验证，不能仅凭 `PUBLUS` 品牌名放行。
- BOOK☆WALKER 的授权带过期和来源限制；测试不应保存 `auth_info`，应 mock 授权响应或只保存无敏感值的结构夹具。
- 1.x 的纯算法移植应单独放在无 DOM、无网络的模块中，并为解包、文件名派生、块排列分别写单元测试；这样适配器层只负责会话许可、页序校验和结果组装。
- 本次没有保存作品图像、授权参数、Cookie 或 `cid`；像素比较和复原都在内存中完成。
