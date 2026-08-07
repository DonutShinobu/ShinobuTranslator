# 连续翻译模式：实施与验证计划

排期、拆任务、选择测试或开始任一代码切片时读取本文。先读通用设计 [`continuous-translation-reader-engines.md`](./continuous-translation-reader-engines.md)；涉及 ComiciViewer 时再读 [`continuous-translation-comici.md`](./continuous-translation-comici.md)。

每个切片独立保持类型检查和相关测试为绿。开始前用 CodeGraph 复核涉及符号及当前工作树差异。

## 1. 实施切片

### 切片 1：契约、注册表与 Comici 结构适配

交付：

- `continuous/contracts.ts` 与 `readerEngineRegistry.ts`。
- Comici 强指纹、contextKey、页面枚举、可见跨页和 observer。
- 无作品图像的 DOM 夹具与适配器测试。

完成条件：结构变化能够产生通用信号；没有捕获、队列、UI 或图片翻译执行副作用。

### 切片 2：扩展域页面产物存储与标签页状态

交付：

- `PageArtifactPort` interface、源快照/完成译图两类 artifact、扩展域 OPFS 实现、runtime-message Adapter 和 sender/session 校验。
- Chromium/Firefox 能力探针；必要时增加经过同样测试的 IndexedDB Blob 适配器。
- `storage.session` 标签页开关与 tab/document 清理。

完成条件：两个浏览器目标都能原子写入、读取、删除两类 Blob；配额、结果替换源快照、tab 关闭、旧 document 和 service worker 冷启动清理测试通过。

### 切片 3：稳定跨页与页面采集

交付：

- `stableSpreadMonitor`、感知哈希和去重。
- 从显式截图流程抽取无 UI 的可见标签页截图/裁剪模块。
- Canvas 导出优先、一次截图裁剪多页、UI 隐藏恢复。

完成条件：双页降级只产生一次 `captureVisibleTab`；动画中间态和扩展自身 UI 不进入快照。

### 切片 4：FIFO 与图片翻译执行拥有者

交付：

- `ContinuousTranslationController` 的会话与单页状态机。
- 无业务上限 FIFO、快照引用生命周期、失败分类和手动重试。
- `continuous` 自动活动与现有仲裁器集成，只允许本地图片流水线执行。

完成条件：至少 1,000 个小型模拟快照保持严格 FIFO，完成结果可回读，且 content 内存不随源图或译图 Blob 总量线性增长；显式活动替代、恢复和迟到结果隔离测试通过。

### 切片 5：投影、显示模式与紧凑控件

交付：

- 页面覆盖层、revision 校验、回翻恢复、ResizeObserver 和全屏重挂载。
- 与 Pixiv 阅读栏同一视觉语言的固定紧凑控件。
- 开关、原/译显示、短状态、错误行和失败重试。

完成条件：控件不阻挡阅读器交互；缩放、全屏、单双页和 Canvas 重挂载后只显示匹配 revision 的结果。

### 切片 6：内容入口集成与真实回归

交付：

- 在 content 入口并行启动阅读器引擎注册表，保持现有 `SiteAdapter` 选择不变。
- content lifecycle、background 消息和清理的端到端接线。
- Chromium/Firefox 构建、自动化测试与首个公开页面回归记录。

完成条件：通用设计的全部完成标准和 Comici 真实页面回归均有证据；Twitter、Pixiv、E-Hentai、显式截图与上下文菜单回归无变化。

## 2. 自动化验证矩阵

行为测试主要穿过 `ContinuousTranslationModule` 的外部 interface，注入 fake `ReaderEngineAdapter`、in-memory `PageArtifactPort`、fake `VisibleTabCapturePort` 和现有执行 fake。新增测试至少包括：

- `readerEngineRegistry`：只选择强匹配，多个强匹配时按显式优先级且记录诊断证据。
- 稳定跨页：动画期间不捕获，稳定窗口后只发一次；通过模块可观察结果断言，并使用 fake timers。
- `contentFingerprint`：缩放/轻微重采样保持匹配，不同页面超过阈值。
- 连续翻译模块：严格 FIFO、无业务上限、翻页不取消旧项目、去重、显示模式独立。
- 仲裁：自动活动不能替代显式活动；显式活动替代后迟到结果不投影，之后能够恢复。
- 错误分类：图片局部故障继续，流水线运行环境故障暂停。
- 页面采集行为：Canvas 成功、tainted/null 降级、双页只调用一次截图、失败后 UI 必定恢复。
- 页面投影行为：revision 校验、回翻恢复、ResizeObserver、全屏迁移、原/译切换。
- `PageArtifactPort` Adapter contract：两类 artifact 的原子写入、读取/删除、结果替换源快照、配额错误、content session 隔离、孤儿清理；in-memory 与生产 Adapter 跑同一 contract suite。
- 标签页状态：同源刷新延续、跨域结束、tab 关闭清理。

测试夹具不包含作品图像。

## 3. 每个切片的验证命令

至少运行：

```text
npm run typecheck:extension
npm run typecheck:tests
npx vitest run <本切片相关测试文件>
```

切片 2 与切片 6 还要运行：

```text
npm run build:extension:chromium
npm run build:extension:firefox
```

最终集成运行仓库当时定义的完整 `npm run check`；若工作树有无关失败，记录准确命令、失败文件和为何与本设计无关，不能用局部绿代替完整结果。

## 4. 最终交付证据

最终实现说明必须包含：

- 每个完成标准对应的测试或真实页面证据。
- Chromium 与 Firefox 快照存储能力探针结果。
- Comici 首个回归页面的结构/状态记录，不含作品图像。
- FIFO 快速翻页、回翻、后台标签页、全屏、配额不足和三类执行结果的验证结果。
- 现有站点适配器与显式截图入口的回归结果。
- 所有新增权限；预期应为空，若不为空必须重新取得产品决策。
