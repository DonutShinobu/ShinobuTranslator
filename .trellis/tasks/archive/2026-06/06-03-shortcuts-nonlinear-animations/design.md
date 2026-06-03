# 技术设计：快捷键与非线性动画

## 边界

本任务只改 Chrome 扩展前端三类运行上下文：

- `public/manifest.json`：声明 Chrome `commands` 默认快捷键。
- `src/background/index.ts`：监听命令并转发到当前标签页内容脚本。
- `src/content/**`：处理截图快捷键、悬停目标翻译和滚轮动画。
- `src/popup/**`：展示快捷键状态、未绑定提示和浏览器快捷键管理入口。

不改翻译 pipeline、模型加载、OCR、inpainting、typesetting 或站点适配器的核心算法。

## 快捷键方案

采用“沉浸式翻译式”混合方案：

- 浏览器级触发走 Chrome `commands`。
- popup 使用 `chrome.commands.getAll()` 读取实际绑定状态。
- popup 提供按钮打开 `chrome://extensions/shortcuts`，真实改键由 Chrome 扩展快捷键管理页完成。
- 默认快捷键固定为：
  - `Alt+Q`：截图翻译。
  - `Alt+W`：翻译当前鼠标悬停元素。

### Manifest 命令

新增两个命令：

- `start-screenshot-translate`
  - suggested_key: `Alt+Q`
  - description: `截图翻译`
- `translate-hover-target`
  - suggested_key: `Alt+W`
  - description: `翻译悬停元素`

### Background 转发

在 `src/shared/chrome.ts` 扩展 `ChromeLike` 类型，增加：

- `commands.getAll`
- `commands.onCommand.addListener`

在 `src/background/index.ts` 初始化时注册 `chrome.commands.onCommand`：

- `start-screenshot-translate` 转发 `{ type: 'mt:start-screenshot-translate' }`
- `translate-hover-target` 转发 `{ type: 'mt:shortcut-translate-hover' }`

命令没有用户可见响应通道；如果目标 tab 不可用或 content script 未注入，background 只做 best-effort 忽略，与现有右键菜单发送失败处理保持一致。

### Content 消息

在 `src/shared/messages.ts` 新增 `ShortcutTranslateHoverMessage` 和对应 success response，便于类型覆盖。

`src/content/index.ts` 保留现有右键流程：

- `contextmenu` 事件继续记录 `contextMenuTarget`。
- `mt:context-menu-translate` 只消费最近右键目标。

新增悬停快捷键流程：

- 捕获 `pointermove` / `mousemove`，记录最近鼠标位置和最近可用页面元素。
- `mt:shortcut-translate-hover` 到达时，根据当前悬停点重新用 `document.elementsFromPoint()` 收集候选元素，避免使用过时 DOM。
- 如果悬停目标是可用 `HTMLImageElement`，沿用 `translateImageInFloatingOverlay(originalUrl, documentRect)`。
- 如果悬停目标不是图片，复用截图候选逻辑生成 `ScreenshotSelection`，调用 `translateScreenshotSelection(selection)`。
- 忽略 ShinobuTranslator 自身 UI、`body`、`documentElement`、不可见元素和过小矩形。
- 找不到有效悬停目标时展示中文轻量提示：`未找到可翻译区域`。

轻量提示在内容脚本侧实现为临时 DOM，样式加到 `injectStyles()`，class 使用 `mt-x-` 前缀，不使用 `alert()`。

## Popup 快捷键管理

在 popup 增加“快捷键”区域：

- 展示“截图翻译”和“翻译悬停元素”两行。
- 每行显示 `chrome.commands.getAll()` 返回的实际快捷键。
- 如果快捷键为空，显示“未绑定”，并提示可能被占用或已清空。
- 提供“管理快捷键”按钮，调用 `chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })`。

popup 不直接写入快捷键；这样符合 Chrome 官方命令模型，避免给用户造成“扩展能直接保存浏览器级快捷键”的误导。

## 动画方案

### 截图元素候选切换

`src/content/core/ui.ts` 的 `requestScreenshotSelection()` 当前在滚轮切换候选时立即调用 `renderElementCandidate()` 和 `setRectStyle()`。

新增 CSS：

- `.mt-x-screenshot-select[data-phase='selecting'] .mt-x-screenshot-select-rect[data-mode='element']`
- 仅对 `left`、`top`、`width`、`height` 做 `180ms cubic-bezier(0.2, 0.85, 0.25, 1)` 过渡。
- 手动框选 `data-mode='manual'`、确认态移动/调整大小不启用该过渡，避免拖拽手感变黏。

最终 `ScreenshotSelection` 仍来自数值 rect，不依赖动画中的视觉状态，保证截图精度。

### 浮动译图滚轮缩放

`TranslatorCore.attachScreenshotResultZoom()` 当前滚轮后立即写入 host 的 left/top/width/height。

新增 `mt-x-screenshot-result-zooming` 类：

- 滚轮触发前给 host 加类。
- CSS 对 `left`、`top`、`width`、`height` 使用同一非线性 easing。
- 连续滚轮时重置清理计时器，最后一次滚轮后移除类。
- 只在缩放时启用，拖拽时无过渡。

缩放锚点继续使用 `scaleScreenshotRectAroundPoint()`，保持鼠标所在点为视觉锚点。

## 风险与处理

- Chrome 若因占用导致 `Alt+Q` / `Alt+W` 未注册，popup 显示未绑定并引导用户进入快捷键管理页。
- `Alt+W` 依赖当前鼠标位置；如果用户打开 popup 后再触发快捷键不适用，因为命令作用于当前页面，实际使用应在页面上按快捷键。
- 页面元素可能在 pointermove 后被删除；触发时重新调用 `elementsFromPoint()` 降低陈旧引用风险。
- 过渡动画可能影响拖拽手感；只在元素候选和缩放两类滚轮行为开启。
- 命令发送失败不应抛到 background service worker 顶层；保持 best-effort。
