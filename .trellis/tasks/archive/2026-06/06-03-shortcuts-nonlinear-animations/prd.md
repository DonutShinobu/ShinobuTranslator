# 快捷键与非线性动画

## 目标

为“截图翻译”和右键“翻译图片”补充键盘触发入口，并让 popup 能管理相关设置；同时优化两类滚轮交互的视觉反馈，让截图选择元素切换和浮动译图缩放更顺滑、非线性。

## 用户价值

- 用户不必每次打开右键菜单即可启动截图翻译或翻译当前右键/页面目标。
- 用户可以在 popup 中看到和调整快捷键相关行为，减少“按了没反应”的困惑。
- 滚轮切换元素层级和滚轮缩放浮动图片时，选区/图片变化更自然，不再是硬跳。

## 已确认事实

- 当前 `public/manifest.json` 没有 `commands`，只声明了 `contextMenus`、`tabs`、`storage` 等权限。
- `src/background/index.ts` 注册了两个右键菜单：`translate-image`（翻译图片）和 `translate-screenshot`（截图翻译）。
- `src/background/index.ts` 通过 `chrome.tabs.sendMessage` 向内容脚本发送 `mt:context-menu-translate` 或 `mt:start-screenshot-translate`。
- `src/content/index.ts` 会记录最近一次右键目标；右键“翻译图片”优先翻译图片浮层，否则生成截图选区；截图翻译调用 `core.startScreenshotTranslate()`。
- `src/content/core/TranslatorCore.ts` 已提供 `startScreenshotTranslate()`、`translateImageInFloatingOverlay()`、`translateScreenshotSelection()`。
- popup 设置模型位于 `src/shared/config.ts` 的 `ExtensionSettings`，popup 通过 `mt:get-settings` / `mt:set-settings` 自动保存。
- 截图选择 UI 位于 `src/content/core/ui.ts` 的 `requestScreenshotSelection()`；未确认状态下滚轮通过 `getNextScreenshotElementCandidateIndex()` 在元素候选间切换。
- 浮动译图缩放位于 `TranslatorCore.attachScreenshotResultZoom()`，当前滚轮每次按 `1.12` 或 `1 / 1.12` 立即改写位置和尺寸。
- Chrome 官方 Commands API 要求快捷键在 manifest 的 `commands` 中声明；真实快捷键可由用户在 `chrome://extensions/shortcuts` 管理，API 可读取 `chrome.commands.getAll()`，但没有从扩展页面直接写入快捷键的能力。
- Chrome 官方文档说明扩展快捷键必须包含 `Ctrl` 或 `Alt`，且部分系统/Chrome 快捷键优先级高于扩展，无法覆盖。

## 竞品调研

- 陪读娃 / 陪读蛙（Read Frog）对应开源项目 `mengxi-ream/read-frog`。
  - `wxt.config.ts` 的 manifest 权限没有 `commands`，也没有 manifest `commands` 声明。
  - 默认网页翻译快捷键是 `Alt+E`，写在 `src/utils/constants/translate.ts` 的 `DEFAULT_AUTO_TRANSLATE_SHORTCUT_KEY`。
  - options 页面 `PageTranslationShortcut` 使用 `ShortcutKeyRecorder` 录入快捷键，保存到 `translate.page.shortcut`。
  - `ShortcutKeyRecorder` 监听 `document.keydown`，将按键归一化为可移植字符串，支持 `Backspace` / `Delete` 清空。
  - 内容脚本 `bindTranslationShortcutKey()` 读取配置后用 `@tanstack/hotkeys` 的 `HotkeyManager.register()` 注册，并设置 `ignoreInputs: true`、`preventDefault: true`、`stopPropagation: true`。
  - 结论：Read Frog 的“可在设置页更改快捷键”主要是内容脚本内自定义热键，不是 Chrome 官方 `commands` 快捷键。
- 沉浸式翻译当前仓库说明它不是开源源码仓库，只包含 Release 和反馈；但仓库 `dist/chrome/manifest.json` 可看到实际构建产物。
  - manifest 里声明了 `commands`：`toggleTranslatePage` 默认 `Alt+A`、`toggleTranslateTheWholePage` 默认 `Alt+W`、`translateInputBox` 默认 `Alt+I`、`toggleSidePanel` 默认 `Alt+S`，其余命令多为无默认 suggested_key。
  - `dist/chrome/default_config.json` 同时有 `shortcuts` 配置表，默认包含 `toggleTranslatePage: "Alt+A"`、`toggleTranslateTheWholePage: "Alt+W"`、`toggleSidePanel: "Alt+S"`、`translateInputBox: "Alt+I"`。
  - `dist/chrome/background.js` 监听 `commands.onCommand`，收到命令后向 content 发送同名 method，并附带 `trigger: "shortcut"`。
  - `dist/chrome/options.js` 的快捷键设置页会使用 `commands.getAll`，展示“快捷键设置”，并给 Chrome 用户提供打开 `chrome://extensions/shortcuts` 的入口；文案也提示 Chrome 内核浏览器需到扩展快捷键管理页修改。
  - 官方用法文档写明默认快捷键为 `Alt+A` / `Alt+W`，若冲突可在“设置页 - 界面设置 - 快捷键管理”更改，也举例可设为 `Alt+Q`、`Alt+E`。
  - 结论：沉浸式翻译是官方 `commands` 与内部 `shortcuts` 配置混合方案；真正的浏览器级扩展快捷键仍依赖 manifest / 浏览器快捷键管理，设置页负责展示、分组、跳转和部分自定义功能配置。

## 初始需求

- 新增“截图翻译”快捷键，初步默认 `Alt+Q`。
- 新增右键“翻译图片”对应的快捷键，初步默认 `Alt+W`。
- 默认键位固定为用户初始设想：截图翻译 `Alt+Q`，右键/当前目标翻译 `Alt+W`；不因为沉浸式翻译也使用 `Alt+W` 而更换默认键位。
- 若默认快捷键被 Chrome 或其他扩展占用，popup 只提示未绑定并引导用户到浏览器快捷键管理页修改。
- popup 需要提供快捷键相关设置或管理入口。
- 滚轮调节浮动译图大小时，需要加入非线性过渡动画。
- 截图模式中，滚轮选择不同页面元素时，需要加入非线性过渡动画。

## 验收标准草案

- [ ] manifest 中声明两个 Chrome `commands`：截图翻译默认 `Alt+Q`，右键/当前目标翻译默认 `Alt+W`。
- [ ] background 监听 `chrome.commands.onCommand`，将命令发送到当前活动标签页内容脚本。
- [ ] popup 以“沉浸式翻译式”方式显示快捷键状态：读取 `chrome.commands.getAll()`，展示当前绑定，若为空则提示可能被占用或已清空，并提供打开 `chrome://extensions/shortcuts` 的入口。
- [ ] popup 不伪装成可以直接写入 Chrome 官方快捷键；真实浏览器级改键通过 Chrome 扩展快捷键管理页完成。
- [ ] 触发截图翻译快捷键后，进入现有截图选择流程。
- [ ] 触发“翻译图片”快捷键后，选择当前鼠标悬停的页面元素生成翻译目标。
- [ ] 右键菜单“翻译图片”仍复用右键事件记录的目标，不被快捷键悬停逻辑破坏。
- [ ] 当当前悬停元素不可用或是 ShinobuTranslator 自身 UI 时，给出中文错误提示，不误翻译扩展 UI。
- [ ] 滚轮切换截图候选元素时，选区框位置和尺寸使用非线性 easing 过渡，不影响最终截图矩形精度。
- [ ] 滚轮缩放浮动译图时，图片位置和尺寸使用非线性 easing 过渡，并保持以鼠标所在点为缩放锚点。
- [ ] 运行 `npm run build` 和相关单元测试通过。

## 暂定范围外

- 不新增第三方动画库。
- 不改变翻译 pipeline、OCR、inpainting 或 typesetting 逻辑。
- 不引入 React 到 content script。
- 不把截图选择改造成独立完整截图工具。

## 待确认问题

- 已确认采用沉浸式翻译式混合方案：浏览器级触发走 Chrome `commands`；popup 读取、展示、提示并跳转到浏览器快捷键管理页。
- 已确认默认键位按用户要求固定为 `Alt+Q` / `Alt+W`，不考虑与沉浸式翻译默认快捷键的共存冲突。
- 已确认 `Alt+W` 选择当前鼠标悬停的页面元素，不依赖最近右键目标。
- 暂无阻塞问题，等待用户确认后进入实现。
