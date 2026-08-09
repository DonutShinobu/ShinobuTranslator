# PUBLUS Reader 适配边界

- 状态：当前页已实现；全量明确不支持
- 最近确认日期：2026-08-09
- 引擎 ID：`publus-reader`

## 强指纹

适配器不绑定客户域名。以下证据必须同时成立：

- 页面加载 `viewer_image_<version>.js`；普通 `viewer_<version>.js` 不算固定版式图片阅读器；
- 存在 `#viewer > #renderer`；
- `#viewport0`、`#viewport1` 或 `#viewportW` 中存在 Canvas；
- `#pageSliderCounter` 符合 `current/total`。

活动页以 viewport 与 Canvas 的实际 `display`、`visibility`、`opacity`、视口交集和 z-index 选择，不能依赖会滞后的 `.currentScreen` 类。

## 已实现能力

- 当前计数器转换为稳定的零基页身份；
- 活动 Canvas 优先导出，失败时沿用通用可见标签页截图降级；
- 译图以独立、不可交互的绝对定位图片覆盖活动 viewport；
- MutationObserver、ResizeObserver、全屏与窗口尺寸变化触发重新协调；
- 不替换 Canvas，不读取 `NFBR` 私有运行态。

## 为什么“翻译全部”返回 unsupported

PUBLUS 1.x 的公开 `configuration_pack.json` 使用内容级封装；完整页资源恢复还依赖阅读器解包后的会话参数。PUBLUS 2.x 虽可公开读取页面配置包，但试读页的权威顺序/子集仍由阅读器内部装载状态决定。仅凭计数器猜测 `p-0001` 等文件名会在封面、折页、任意 XHTML 文件名或试读子集上产生假全量。

在当前已确认边界内禁止：

- 读取 `window.NFBR` 或堆内私有模型；
- 注入脚本/Hook 网络或解码函数；
- 模拟后台翻页以逐页收集；
- 用规则化文件名猜测冒充 authoritative discovery。

因此 `discoverReadingPages()` 固定返回 `unsupported-format`，但不影响“翻译当前页”。未来只有在 PUBLUS 提供可独立验证的当前会话公开页序与资源恢复协议后，才扩展全量。

## 2026-08-09 真实站点回归

- comicブースト：<https://comic-boost.com/product/01450024>（PUBLUS 1.0.5）
- マンガBANGブックス：<https://manga-bang.com/store/books/BT000237294900100101>（PUBLUS 1.0.7）
- BOOK☆WALKER 试读入口说明：<https://www.kadokawa.co.jp/topics/16322/>（PUBLUS 2.0.29）

三个站点均确认固定版式 `viewer_image`、成对 viewport、Canvas 和页计数器；BOOK☆WALKER 还覆盖 `#viewportW` 与 `.currentScreen` 不一致的选择场景。自动测试不包含作品图像。
