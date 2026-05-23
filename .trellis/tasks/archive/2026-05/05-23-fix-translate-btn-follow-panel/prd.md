# fix-translate-btn-follow-panel

## Goal

修复 x.com 大图查看器中翻译按钮不跟随文字面板展开/收起移动的问题。当用户在图片大图模式下展开或收起右侧文字面板时，Twitter 自带的按钮会跟随面板位置变化，但我们的翻译按钮保持绝对定位在初始位置不动。

## What I already know

- 翻译按钮通过 `position:absolute` 定位在 dialog 容器内（`twitter.ts:155`）
- `repositionAnchor()` 函数（`twitter.ts:112-131`）读取 Twitter 参考按钮的 `getBoundingClientRect()` 来计算位置
- `repositionAnchor` 仅在 `createUiAnchor` 时调用一次（`twitter.ts:164-166`），之后不再触发
- `observe()` 的 MutationObserver 已经能捕获面板切换引起的 DOM 变化
- `sync()` 方法只处理图片的新增/移除，不重新定位已挂载的锚点
- 参考按钮 selector: `referenceButtonSelector`（`twitter.ts:107-108`）

## Root Cause

`repositionAnchor` 只在创建时调用一次。文字面板展开/收起引起布局变化时，参考按钮位置移动，但绝对定位的锚点不会自动跟随。

## Requirements

- 翻译按钮需在文字面板展开/收起时跟随参考按钮位置
- 重新定位应在布局变化完成后执行（避免在 CSS transition 过程中定位到中间状态）
- 方案需自包含，不修改 SiteAdapter 接口或 TranslatorCore

## Acceptance Criteria

- [ ] 在大图模式下展开文字面板后，翻译按钮位置跟随参考按钮
- [ ] 在大图模式下收起文字面板后，翻译按钮位置跟随参考按钮
- [ ] 翻译按钮不在 transition 过程中跳跃到中间位置
- [ ] 当 dialog 关闭/锚点移除时，observer 自动清理
- [ ] 不影响现有功能（pixiv adapter、正常图片切换等）

## Definition of Done

- 代码修改完成
- 通过 agent-browser 在 x.com 实际测试验证
- Lint/typecheck 通过

## Technical Approach

**方案：在 `createUiAnchor` 中为锚点设置自定位机制**

在 `createUiAnchor` 中：
1. 对 dialog 设置 **ResizeObserver**，当 dialog 尺寸变化时调用 `repositionAnchor`
2. 对 dialog 添加 **`transitionend` 事件监听**，当 CSS transition 完成时调用 `repositionAnchor`（Twitter 面板切换使用 transition 动画）
3. 在 observer 回调中检查 `anchor.isConnected`，如果锚点已从 DOM 移除则自动 disconnect 和 removeEventListener

优点：
- 不修改 SiteAdapter 接口或 TranslatorCore
- 自包含，创建和清理都在 `createUiAnchor` 内处理
- ResizeObserver + transitionend 双重保障覆盖各种布局变化场景
- 性能开销小（只在布局变化时触发）

## Out of Scope

- 不修改 SiteAdapter 接口
- 不修改 TranslatorCore
- 不改变按钮的定位方式（保持 absolute positioning）
- 不处理 pixiv adapter（pixiv 不存在此问题）

## Technical Notes

- 关键文件: `src/content/adapters/twitter.ts`（`repositionAnchor` + `createUiAnchor`）
- ResizeObserver 观察 dialog 的 border-box 尺寸变化
- transitionend 需监听 dialog 上的事件（面板切换的 transition 在 dialog 内部元素上触发，事件会冒泡到 dialog）
- 参考: `referenceButtonSelector`（`twitter.ts:107-108`），`anchoredVerticalGapPx`（`twitter.ts:109`）