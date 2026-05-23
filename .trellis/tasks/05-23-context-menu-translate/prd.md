# 右键菜单翻译图片

## Goal

在任意网站上右键点击图片时，Chrome 右键菜单中出现"翻译图片"选项，点击后调用现有翻译管线翻译图片，替换原图并在图片上方浮出翻译按钮（显示进度、切换原图/译图）。

## Requirements

- 在所有网站上注册右键菜单项"翻译图片"，仅 `contexts: ["image"]` 时显示
- 点击菜单后，content script 通过 `contextmenu` 事件记住的 `<img>` 元素执行翻译
- 翻译完成后直接替换原图 `src`，并在图片上方浮出现有翻译按钮 UI
- 翻译按钮提供：进度显示、翻译完成后切换原图/译图、手动关闭
- 在 x.com/Pixiv 上，如果右键的图片已被 adapter 管理，优先走 adapter 逻辑；未被覆盖的走通用流程
- 通用场景使用 light theme
- 翻译按钮位于图片上方，不遮挡图片内容
- MutationObserver 监听图片移除自动清理 + 用户手动关闭按钮
- manifest 新增权限：`contextMenus`、`<all_urls>` host_permissions
- content script 注入到 `<all_urls>`（声明式）

## Acceptance Criteria

- [ ] 任意网站右键图片 → 菜单出现"翻译图片"
- [ ] 点击菜单 → 图片开始翻译，按钮显示进度
- [ ] 翻译完成 → 原图被替换为译图，按钮变为"显示原图"
- [ ] 点击"显示原图" → 切回原图；点击"显示译图" → 切回译图
- [ ] 按钮有关闭 × 按钮，点击后恢复原图并移除按钮
- [ ] 图片从 DOM 移除后，按钮和 state 自动清理
- [ ] x.com/Pixiv 上 adapter 管理的图片，右键翻译走 adapter 逻辑
- [ ] x.com/Pixiv 上非 adapter 管理的图片，右键翻译走通用流程
- [ ] 现有 x.com/Pixiv 翻译功能不受影响

## Definition of Done

- Lint / typecheck 通过
- 手动测试：在非 x.com/Pixiv 网站右键翻译图片成功
- 手动测试：x.com/Pixiv 上右键翻译图片正常（adapter 优先 + 通用回退）
- 现有功能无回归

## Out of Scope

- CSS background-image 翻译（仅支持 `<img>` 元素）
- 自动检测页面背景色适配 theme
- 右键翻译 canvas/SVG 等非 img 元素
- 批量翻译（一次右键翻译多张图）

## Technical Notes

### 核心架构

- **消息流**：background 注册 `chrome.contextMenus` → 用户点击 → background 通过 `chrome.tabs.sendMessage` 通知 content script → content script 用 contextmenu 事件记住的 `<img>` 元素执行操作
- **通用翻译流程**：content script 捕获 `contextmenu` → 记住 `event.target` → 收到 background 消息 → 调用 `TranslatorCore` 的翻译逻辑 → 替换 `img.src` + 浮出按钮
- **与 adapter 共存**：在 x.com/Pixiv 上，`TranslatorCore` 已有 adapter；右键翻译时检查 `mounted` map，若已存在则触发现有 `handleTranslateClick`，否则走通用流程

### 关键文件

- `src/content/core/TranslatorCore.ts` — 翻译核心逻辑，需扩展支持右键触发的通用翻译
- `src/content/core/ui.ts` — UI 元素创建和渲染，需扩展按钮定位（图片上方）和关闭按钮
- `src/content/core/types.ts` — 类型定义，可能需新增通用 ImageTarget 的 state 管理
- `src/content/index.ts` — content script 入口，需监听 contextmenu + 接收 background 消息
- `src/background/index.ts` — 注册 contextMenus + 发消息给 content script
- `src/shared/messages.ts` — 新增右键翻译消息类型
- `public/manifest.json` — 新增权限和 content script 匹配

### 设计决策（已确认）

1. 所有网站生效（`<all_urls>`）
2. 直接替换原图 + 浮出翻译按钮
3. 按钮浮在图片上方
4. 声明式注入 content script 到 `<all_urls>`
5. 右键菜单 `contexts: ["image"]`
6. content script 捕获 `contextmenu` 事件记住目标元素
7. x.com/Pixiv 上优先走 adapter，未覆盖走通用流程
8. 通用场景使用 light theme
9. 手动关闭 + MutationObserver 自动清理
10. 菜单文字：翻译图片
