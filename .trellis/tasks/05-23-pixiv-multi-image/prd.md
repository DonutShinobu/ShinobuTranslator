# Pixiv 多图翻译支持

## Goal

在 Pixiv 阅读模式中为多图作品添加翻译功能：底栏提供「翻译」和「翻译全部」两个按钮，翻译后可切换原图/译文。翻译全部时串行执行，按钮文字实时显示进度。

## Requirements

### 仅阅读模式

- 正常视图（Mode 1）行为不变，只翻译 p0 单页（现有逻辑）
- 阅读模式（Mode 2，URL 带 `#1` 等 hash）中提供多图翻译功能

### 底栏按钮

- 阅读模式底栏（`.sc-51f2d7c7-0` 区域）添加两个按钮，复用 `mt-x-control` 样式
- **「翻译当前页」按钮**：翻译当前可见的页面
  - 阅读模式两页展开时翻译两页，单页显示时翻译一页
  - 翻译进行中按钮文字显示进度：`1/2 检测中`（当前页/本批总数 + 阶段名）
  - 翻译后点击可切回原图，再点切回译文（复用现有 toggle 逻辑）
- **「翻译全部」按钮**：串行翻译所有页面
  - 翻译后点击可切回原图/译文（同上）
  - 进行中按钮文字变为进度：`2/44 检测中`（页数/总数 + 当前阶段）
  - 进行中隐藏「翻译当前页」按钮，避免误触
  - 完成后不恢复「翻译当前页」按钮（全部已翻译，无需单页操作）

### 翻译全部行为

- 串行执行（一次翻译一页），避免资源争抢
- 管线使用图片 URL 下载，不依赖 DOM 中的 `<img>` 元素（因为虚拟渲染离屏图无 img）
- 关闭阅读模式时翻译全部继续后台执行，切回阅读模式后可看到已完成的结果

### 进度显示

- 「翻译当前页」和「翻译全部」按钮文字实时更新：`N/total 阶段名`
- 阶段名复用现有 stageText 映射（准备中 → 文本检测 → ... → 完成）
- 「翻译当前页」：当前展开两页时 total=2，一页时 total=1
- 每完成一页更新进度，全部完成后按钮文字恢复为「翻译当前页」或「翻译全部」

## Acceptance Criteria

- [ ] 进入 Pixiv 多图阅读模式后，底栏出现「翻译当前页」和「翻译全部」按钮
- [ ] 点击「翻译当前页」翻译当前可见页（两页展开时翻译两页，单页时翻译一页），按钮文字显示 `N/total 阶段名`
- [ ] 点击「翻译全部」串行翻译所有页，按钮文字显示 `N/total 阶段名`
- [ ] 翻译全部进行中「翻译当前页」按钮隐藏，完成后不恢复
- [ ] 翻译全部完成后点击「翻译全部」可切回原图/译文
- [ ] 关闭阅读模式后翻译全部继续后台执行
- [ ] 正常视图和单图作品行为不受影响

## Definition of Done

- 功能在 Pixiv 多图页面正常工作
- 不影响正常视图和单图页面的现有行为
- Lint / typecheck 通过
- 编译插件并替换 D:\Downloads\ShinobuTranslator 供用户测试

## Out of Scope

- 翻译全部的取消功能
- 并行翻译多张图
- 正常视图中的翻译全部
- 翻译结果的缓存/持久化

## Technical Approach

### 核心变更

1. **pixivAdapter.findImages()** — 阅读模式中通过 `.gtm-expand-full-size-illust` 查找所有图片链接，每页一个 ImageTarget
2. **pixivAdapter 新增「翻译全部」UI** — 在阅读模式底栏注入按钮组（翻译 + 翻译全部），替代每页图片右上角的 overlay 按钮
3. **TranslatorCore 新增 translateAll 逻辑** — 串行遍历所有 ImageTarget，逐页执行翻译管线，更新按钮文字进度
4. **虚拟渲染处理** — 翻译全部使用 `originalUrl` 下载图片，不依赖 DOM img 元素；翻译完成后通过 `applyImage` 替换可见页的 src

### 关键技术决策

- 使用 GTM 前缀 class 作为选择器（稳定），不使用 hashed class（`sc-xxx`）
- 阅读模式检测：URL hash 存在（`#1` 等）或 DOM 中存在阅读模式容器
- 翻译全部后台继续：使用 AbortController 管理，关闭阅读模式不中断管线

## Research References

- [`research/pixiv-dom-structure.md`](research/pixiv-dom-structure.md) — Pixiv 多图页面完整 DOM 结构分析

## Technical Notes

- 关键文件：
  - `src/content/adapters/pixiv.ts` — Pixiv 适配器
  - `src/content/core/TranslatorCore.ts` — 核心翻译逻辑
  - `src/content/core/types.ts` — SiteAdapter、ImageTarget、PhotoState 类型
  - `src/content/core/ui.ts` — UI 元素创建
- Pixiv 选择器稳定性：GTM class 稳定（用于分析追踪），hashed class 不稳定
- 阅读模式图片 `data-page` 是 1-indexed，文件名 `p{N}` 是 0-indexed
