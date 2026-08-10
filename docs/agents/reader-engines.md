# 阅读模式：阅读器引擎框架与已适配引擎

- 状态：已实现
- 最近确认日期：2026-08-10
- 适用入口：阅读栏中的“翻译当前页 / 翻译全部”

本文记录浏览器扩展阅读器引擎的现行结构与安全约束。阅读器引擎只响应用户显式发起的阅读模式操作，不自动捕获视口附近页面，也不持久化页面快照或译图。

## 1. Module 结构

```text
ReaderEngineAdapter[]
        ↓ strong detection
ReaderEngineRegistry
        ↓ detected adapter + evidence
ReaderEngineReadingModeModule
        ↓ session lifecycle
ReaderEngineReadingModeSession
        ↓ ReadingModeAdapter
ReadingModeController
        ↓ explicit image translation activity
ImageTranslationExecutionArbiter
```

活跃实现位于：

```text
apps/extension/src/content/core/reading/
  readerEngineContracts.ts
  readerEngineRegistry.ts
  readerEngineReadingModeModule.ts
  defaultReaderEngineReadingModeModule.ts

apps/extension/src/content/readerEngines/
```

`ReaderEngineReadingModeModule` 拥有 detection、session 重绑、observer 和控制器生命周期。各 reader adapter 拥有站点结构、资源协议、页面身份、图片还原和投影知识；通用 module 不得硬编码具体清单字段、扰码规则或资源路径。

## 2. Detection seam

`ReaderEngineAdapter.detect()` 只在一组相互印证的运行态证据同时成立时返回 strong detection：

- 阅读器根节点与正文页结构；
- 当前 document 的 session anchor；
- 能区分作品或章节的稳定 context key；
- 引擎专用清单或运行协议证据。

域名、品牌、单个 class、脚本版本号或 CDN 主机不能单独触发 detection。没有 strong detection 时不创建阅读会话。

新增引擎必须在默认 adapter catalog 中显式注册，并提供结构夹具验证 detection 的正例、近似反例与 SPA 重绑。

## 3. 阅读会话

一个 `ReaderEngineReadingModeSession` 同时提供：

- 稳定的 `engineId` 与 `contextKey`；
- 权威的完整正文页发现；
- 当前可见页读取；
- 可选的引擎专用图片准备；
- 可选的逻辑页规划与结果切分；
- 原图/译图投影；
- 结构、导航、几何与渲染稳定信号；
- 显式 `dispose()`。

session anchor、context key 或阅读器根节点变化时必须销毁旧 session 并创建新 session。旧 session 的迟到信号和图片翻译结果不得投影到新上下文。

## 4. “翻译当前页 / 翻译全部”

“翻译当前页”读取当前可见正文页；“翻译全部”必须先取得权威、完整且有上限的页面清单。清单不完整、格式未知或超过引擎上限时失败关闭，不能把虚拟 DOM 中当前挂载的页误当成完整章节。

各页通过 `ImageTranslationExecutionArbiter` 创建的显式活动执行。活动结束或 content context 销毁后，进度与结果停止交付并请求取消。阅读模式不定义跨标签页优先级；本地流水线准入仍由 background 的全局 FIFO 协调。

GigaViewer TTB 等特殊格式可以在 adapter 内规划逻辑页并切分结果。通用控制器只验证计划与切分结果覆盖原始正文页，不理解具体拼接规则。

## 5. 资源与安全

- 只读取当前已授权阅读会话能够正式访问的内容。
- 不绕过登录、购买、授权、水印或区域限制。
- 远程资源必须限制在经过验证的 HTTPS base URL 内。
- 授权查询参数、cookie、token 和内部资源地址不得进入日志或稳定身份。
- 未知协议版本、路径穿越、跨目录资源、页数超限或还原结构不匹配时失败关闭。
- 原图恢复和拼图还原只在内存中进行，不提交作品图像或夹具。

## 6. 已适配引擎

- [ComiciViewer](./reader-engine-comici.md)
- [GigaViewer](./reader-engine-giga-viewer.md)
- [BinB Speed Reader](./reader-engine-binb.md)
- [CLIP STUDIO READER](./reader-engine-clip-studio-reader.md)
- [PUBLUS Reader](./reader-engine-publus-reader.md)

引擎规范是各自结构事实的来源。修改对应 adapter、清单解析、图片还原或真实页面回归时，应同步读取相应文档。

## 7. 验证矩阵

- registry 选择第一个 strong match，并保留 detection evidence；
- session anchor 或 context key 变化时重绑；
- observer 忽略扩展自身投影造成的结构变化；
- 当前页与完整章节使用稳定页面身份；
- 图片准备遵守允许的资源范围并响应取消；
- 逻辑页规划和切分结果完整覆盖正文页；
- 结束活动后不交付迟到进度与结果；
- 销毁 module 后移除 observer、阅读栏和投影。
