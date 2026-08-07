# 连续翻译模式：ComiciViewer 引擎规范

在实现或修改 ComiciViewer 检测、页面枚举、observer、结构夹具或真实页面回归时读取本文。通用会话、快照、FIFO、执行和投影语义以 [`continuous-translation-reader-engines.md`](./continuous-translation-reader-engines.md) 为准。

首个回归页面：<https://bibibi-comic.com/episodes/7e06f5b186c99>

## 1. 强指纹

只有同时满足以下运行态证据才返回 `confidence: 'strong'`：

```text
#comici-viewer[data-comici-viewer-id].-cv
AND #xCVPages.-cv-pages
AND #xCVPages > .-cv-page
```

`/js/viewer/viewer.js`、`cdn-public.comici.jp` 或客户自有 CDN 只能作为诊断证据，不单独触发适配。`window.comiciViewer` 不是契约。

引擎注册表在 document 初始化后观察强指纹出现；没有强匹配时不显示控件，也不回退到通用检测器。

## 2. 阅读上下文

```text
contextKey = "comici:" + data-comici-viewer-id + ":" + location.origin + location.pathname
```

`data-comici-viewer-id` 缺失时检测失败，不使用 URL 猜测 viewer 身份。

## 3. 页面枚举

- 逻辑页槽取 `#xCVPages > .-cv-page` 的 DOM ordinal，ordinal 直接作为 `pageIndex`，不因过滤特殊页而重排。
- 排除 `mode-empty`、`mode-pr`、`mode-good`、`mode-last`。
- 普通页必须包含 `.-cv-page-canvas > canvas` 且具备 `mode-rendered`，才能成为可捕获表面。
- Canvas 矩形中心位于 `#comici-viewer` 可见矩形内，且交集面积至少达到 Canvas 面积的 50%，才视作可见。
- 可见页按 `pageIndex` 升序返回，不按屏幕 x 坐标排序。
- `projectionAnchor` 使用对应 `.-cv-page-content`；适配器不修改其业务 class。

## 4. 监听信号

单个 session 组合以下 observer；所有回调只发通用 `ReaderSessionSignal`：

- `MutationObserver`：`#xCVPages` 的 Canvas childList、页槽 class、根节点方向/单双页/首屏 class、页码文本。
- `ResizeObserver`：`#comici-viewer`、当前可见页槽和 Canvas。
- `transitionend`：`#xCVPages` 或导航轨道，仅触发重新评估。
- `fullscreenchange`、`visibilitychange`。
- 当前页 DOM（如 `.-cv-f-page-current`）变化是导航信号，不单独决定可见页集合。

URL 可能在翻页时保持不变；`MutationObserver` 也可能只看到 Canvas 惰性挂载而看不到像素变化。权威结果始终是稳定时重新读取的页槽、几何与快照指纹。

## 5. 已验证结构

首个回归页面在桌面双页模式中观察到：

- `#comici-viewer[data-comici-viewer-id]`；
- `#xCVPages` 下 16 个固定页槽；
- 初始 4 个已渲染 Canvas、6 个 loaded 页槽；
- 正文 Canvas backing size `848 × 1200`，屏幕矩形随视口缩放；
- 当前页文本 `1`，总页文本 `15`；
- 页面槽位固定、Canvas 子节点在当前页附近惰性挂载。

这些数值只用于回归记录，不得写入生产判断。

## 6. 结构夹具

夹具只保留不含作品像素的 DOM 结构：根属性、页槽 class、空白 Canvas 尺寸、页码节点和几何桩。至少覆盖：

- 强指纹完整、缺一项、页面尚未 hydration。
- 单页、双页、RTL、方向 class 切换。
- 正文页与 `mode-pr/mode-good/mode-last` 混排。
- 页槽固定、Canvas 从 3 个惰性增加到 5 个。
- 同一页 Canvas 重挂载、同一 Canvas backing size 改变。

完成条件：所有夹具都只靠适配器输出页面身份、可见表面与通用信号，不启动快照、FIFO、UI 或图片翻译执行。

## 7. 真实页面回归

在首个回归页面验证：

1. 初始第一页开启。
2. 等待当前跨页分别完成。
3. 快速连续翻 3–5 个跨页，确认 FIFO 不插队。
4. 回翻到已完成页面，确认指纹匹配后立即投影。
5. 切换原图/译图，不影响 FIFO。
6. 调整窗口、单双页和全屏，不重新翻译同内容。
7. 切到后台，确认已冻结项目继续、新捕获暂停。
8. 模拟 Canvas 导出失败，确认一次截图裁剪双页。
9. 模拟图片局部故障、运行环境故障和配额不足。
10. 关闭连续翻译模式，确认取消与清理；重新开启确认完成结果仍可用。
11. 刷新和进入下一话，确认开关延续但旧队列不延续。

完成条件：保存结构、状态和诊断结果，不保存或提交作品图像。
