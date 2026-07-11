# Content Core 与原生 DOM UI 实施计划

## 1. Characterization

- [x] `PhotoStateStore` 测试固定创建/复用、200 项默认缓存、淘汰与 object URL revoke 行为。
- [x] `ImageTranslationController` 覆盖运行中重复点击忽略、失败恢复、成功应用和原图/译图切换。
- [x] `ReadingModeController` 与 `ScreenshotController` 覆盖已译页切换、bar teardown、选择去重和 dispose 后丢弃旧结果。
- [x] UI jank 基线：18 次 render、总计 29.0 ms、最大 14.4 ms。

## 2. 状态与运行器

- [x] 提取 `PhotoStateStore`，集中 URL/cache/dispose。
- [x] 提取 `TranslationRunner`，封装设置、下载、Nano Banana/local pipeline 和 progress。
- [x] 保持诊断日志、timing artifacts；`orchestrator` 仍只在用户动作后动态 import。

## 3. Feature Controllers

- [x] 提取 `ReadingModeController`，保留当前页/全部页和全局原译图切换。
- [x] 提取 `ScreenshotController` 与 `overlayInteraction`。
- [x] Core observer/timer、reading bar、截图选择与活动浮层均有明确 teardown/dispose。

## 4. UI 拆分

- [x] 提取 `ui/styles.ts` 与共享 icons。
- [x] 拆分 image controls、timing/error cards、reading bar、screenshot overlay 和 card state。
- [x] 采用 AST 机械迁移保留原 DOM 层级、全部 `mt-x-` class、data attributes、文案和动画参数。

## 5. Core 收敛

- [x] `TranslatorCore.ts` 从约 1600 行收敛为 163 行，只协调 adapter、store、runner、controllers 和挂载 UI。
- [x] 删除原 `ui.ts` 单体与迁移后的重复逻辑，`ui/index.ts` 使用显式导出。

## 6. 验证

- [x] Content/screenshot/UI/utils 新旧定向测试 30 项通过；新增 controller/store/runner 测试 13 项。
- [x] 完整 `npm run check` 通过：三套 typecheck、43 个测试文件/549 项测试、Release build 与 artifact check。
- [x] 真实浏览器 context-image pipeline/UI jank smoke 通过；后测仍为 18 次 render，总计 13.4 ms、最大 2.0 ms，无退化。阅读/截图状态机由注入式 controller 测试覆盖。
- [x] URL revoke、controller dispose、observer/timer 清理均有明确所有者；`git diff --check` 通过，用户的 `benchmark/images/` 未纳入变更。

## 7. 回滚点

- [x] State、runner、controllers、UI、Core 形成独立文件级变更组；未在用户确认前自动提交。
- [x] UI 提取未修改交互参数，浏览器 smoke 以迁移前基线验证。
