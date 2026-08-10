# PUBLUS Reader 适配边界

- 状态：当前页与“翻译全部”已实现
- 最近确认日期：2026-08-10
- 引擎 ID：`publus-reader`
- 通用契约：[`reader-engines.md`](./reader-engines.md)

## 强指纹

适配器不绑定客户域名。以下证据必须同时成立：

- 页面加载 `viewer_image_1.x.js` 或 `viewer_image_2.x.js`；未知主版本与普通 `viewer_<version>.js` 均不放行；
- 存在 `#viewer > #renderer`；
- `#viewport0`、`#viewport1` 或 `#viewportW` 中存在 Canvas；
- `#pageSliderCounter` 符合 `current/total`。

活动页以 viewport 与 Canvas 的实际 `display`、`visibility`、`opacity`、视口交集和 z-index 选择，不能依赖会滞后的 `.currentScreen` 类。

## 当前页

- 当前计数器转换为稳定的零基页身份；
- 活动 Canvas 优先导出，失败时沿用通用可见标签页截图降级；
- 译图以独立、不可交互的绝对定位图片覆盖活动 viewport，并始终保持原页宽高比；
- PUBLUS 桌面端使用整屏 Canvas 承载书页：竖向封面/末页按方向投影到单侧半屏槽位，正文跨页的两个物理页分别投影到左右槽位，并在槽位内贴书脊对齐；纵屏和横向大页使用整屏槽位；
- MutationObserver、ResizeObserver、全屏与窗口尺寸变化触发重新协调。

## “翻译全部”入口

适配器只被动读取当前 document 的 Resource Timing，定位阅读器已经发出的许可请求和 `configuration_pack.json` 请求。许可地址必须带当前 viewer 的同一个 `cid`；许可响应的 HTTPS 内容基址必须与已观察到的配置目录完全一致。随后所有配置和图片都通过现有后台阅读器资源通道请求，并把 `allowedBaseUrl` 固定为该内容目录。

`configuration.contents` 是唯一权威页序。适配器不枚举配置包顶层键、不猜 `p-0001` 等文件名，最多接受 200 页；正数 `lp` 必须与目录页数一致。

### 1.x packed profile

- 只接受 `{version:"1.0", data:string}` 与解包后 `file-name-version:"1.0"`；
- 配置解包、16 位资源文件名派生、NS/PS/RS 页级种子与块排列均为无网络、无 DOM 的纯算法；
- 每个 `contents` 项必须恰好对应一个 JPEG/PNG 固定布局页面，并提供合法的 `Size`、`BlockWidth/Height`、`DummyWidth/Height`、`NS/PS/RS`；
- 下载的扰码图按块复原，Dummy 区域按配置裁切，输出无损 PNG。

### 2.x plain profile

- 只接受明文固定布局配置；
- 图片地址为 `${item.file}/${Page.No}.${item.type}`；
- 只传播 `pfCd`、`hti`、`bid`、`uuid`、`Policy`、`Signature`、`Key-Pair-Id` 这些已验证短期授权字段，不传播许可响应的任意属性；
- JPEG/PNG 文件直接作为按页准备结果。

两个 profile 都要求 HTTPS 安全相对路径、连续且唯一的目录序号、`rtl`/`ltr` 阅读方向、合法页面尺寸和单页 item。未知版本、路径穿越、跨目录资源、回流文本、多页 item、未知扰码结构或超限内容均失败关闭。首次图片请求失败时只刷新一次许可与配置并重试一次。

## 不允许扩大边界

- 不读取 `window.NFBR` 或堆内私有模型；
- 不注入脚本或 Hook fetch/XHR/解码函数；
- 不模拟翻页或点击来收集页面；
- 不持久化 `cid`、BID、签名、Cookie、配置密钥或作品像素；
- 不动态加载或复制社区脚本。

许可/网络失败映射为 `request-failed`，配置结构问题映射为 `invalid-response`，未知/不支持 profile 映射为 `unsupported-format`；这些失败不影响当前页 Canvas 翻译。

## 2026-08-10 真实站点回归

- comicブースト：<https://comic-boost.com/product/01450024>（PUBLUS 1.0.5，25 页）；
- マンガBANGブックス：<https://manga-bang.com/store/books/BT000160980800100101>（PUBLUS 1.0.7，32 页）；
- BOOK☆WALKER 试读入口说明：<https://www.kadokawa.co.jp/topics/16322/>（PUBLUS 2.0.29，26 页）。

三个站点均通过许可、权威目录和逐页资源回归。自动测试只使用脱敏配置向量和合成棋盘图，不包含作品图像或授权值。协议证据见 [`research-publus-translate-all-2026-08-10.md`](./research-publus-translate-all-2026-08-10.md)。
