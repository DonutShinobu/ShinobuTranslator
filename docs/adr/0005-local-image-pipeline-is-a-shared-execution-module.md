---
status: accepted
---

# 本地图片流水线由共享 execution module 拥有

扩展与 Web 的本地图片流水线执行统一由独立的 `@shinobu/image-pipeline` package 拥有。相比只把现有文件搬进 package，这个选择要求共享 module 同时拥有执行语义、finalization 与资源所有权；Web 的处理批次／本地历史和扩展的产品入口仍留在各自宿主。

## Module 边界

- `@shinobu/image-pipeline` 依赖 `@shinobu/translator-core` 的通用 `TranslationTask`，但不得依赖根 `src`、`apps/*`、Worker 或 Chrome Port。
- package 只公开一个 `ImagePipelineRuntime`；`run(request)` 返回一次 execution 的 `TranslationTask`，`dispose(reason)` 强制停止接收新任务、取消 active task、等待清理并释放可释放的 runtime 资源。内部 executor 不作为第二个 public abstraction。
- runtime 构造时显式接收模型、ONNX、字体、Canvas/image 平台、文本翻译和诊断 ports；配置描述处理结果语义，API Key、Cookie、provider session、模型下载权限和宿主资源作为 runtime capability 提供，绝不进入持久化配置或处理记录。
- 模型、字体和 Worker 的首次准备属于第一个 task 的结构化 `runtime-prepare` 阶段，不增加 public `prepare()` 状态机；初始化失败是运行环境故障，初始化取消必须释放部分资源。
- 浏览器是唯一承诺的产品运行边界；Node adapter 只供测试与 benchmark 使用，public API 不提供 Node CLI、文件系统或服务端部署承诺。
- Nano Banana 整图翻译不属于该 package，而是扩展拥有的独立 executor。它与本地 pipeline 只共享 `TranslationTask`、owner cancellation、最小 failure envelope 和 content context 内的图片翻译执行仲裁器，不共享 request/config、stages、result 或 runtime；只有出现第二个真实消费者时才考虑提取 Nano Banana package。

## Execution contract

- request 包含原始图片、不可变 `PipelineConfig` 与显式 `WorkingCopySpec`。宿主选择 spec，共享 runtime 确定性执行并记录它；扩展首期使用 `source-native` 保持现有像素行为，Web 使用现有的 `normalized` 旋转、铺白和下采样策略。
- 成功结果统一包含译图和版本化流水线处理记录；debug 图片、timing 与诊断摘要只是可选派生产物。record schema、校验与迁移由 `@shinobu/image-pipeline` 独立拥有，未知未来版本 fail-closed，但宿主仍可提取已经保存的译图。
- record 的 OCR、译文与版面几何统一使用工作副本像素坐标，并保存原图到工作副本的显式 transform。`source-native` 的 transform 为 identity；生成 record 不得重新采样输入或改变现有扩展译图的像素与尺寸。两个 endpoint 都返回 record，各宿主自行决定是否持久化；这不构成扩展与 Web 的交换格式或导入功能。
- “无可翻译文本”是结构化的非错误完成结果，返回输入等价结果图与空 record，不自动重试或暂停 owner；宿主不得再通过中文错误消息识别它。
- progress 只以稳定的 stage、operation、计数和 retry 状态承载语义，显示文案由宿主生成；诊断 detail 不得参与控制流。
- 本地 pipeline 与 Nano Banana 各自定义 code/stage，但都映射到 `@shinobu/translator-core` 的最小 failure envelope：`code`、可选 `stage`、`scope: image | runtime`、`retryable`、`messageKey` 与无敏感信息的诊断摘要。execution 负责分类，owner 根据 scope 决定继续或暂停，transport 不得根据异常类型、HTTP 状态或 message 重新分类。
- 流水线自动重试只重做最近失败且可安全重复的操作，不重跑整张图片；快速翻译的部分分片继续使用翻译恢复请求。每个操作首次失败后最多自动重试两次，使用退避并尊重较短的 `Retry-After`，自动等待总预算不超过三十秒；策略不是用户设置，也不进入锁定处理配置。耗尽后按运行环境故障结算，用户手动重试会开始新的 execution，但不改变原图片任务身份。
- owner 生命周期结束必须请求取消；task 统一结算为 cancelled，并携带结构化 reason。底层产生的迟到结果不得交付，且必须释放；不增加单独的 abandoned 终态。
- Canvas、ImageBitmap、mask 和其他 live `PipelineArtifacts` 不得越过 runtime public boundary。runtime 在 success、failure 和 cancel 三条路径上完成冻结、finalization 与释放，Worker/offscreen adapter 不再负责 `disposePipelineArtifacts`。
- `run()` 只允许一个 active task。busy、runtime 已关闭或 request/spec 结构无效时同步抛出 admission error，不创建 task，也不写成图片任务失败；一旦 `run()` 返回 task，该 task 只能以 result、cancelled 或结构化 failure 单次结算。

## 调度与 transport

- 图片任务的产品顺序与优先级属于 owner／arbiter，不属于 runtime。每个 content context 的图片翻译执行仲裁器协调普通图片、截图、阅读／连续模式和 Nano Banana，但不定义跨标签页优先级。
- 扩展 background 另以不理解产品语义的准入协调器维护所有标签页共享唯一 offscreen runtime 的全局 FIFO。offscreen runtime 只接收已获准执行的一个任务，意外重叠才产生内部 busy admission error。
- 首期必须复刻现有全局到达顺序、排队位置、queued cancel、active cancel、Port disconnect 和重连表现；正常用户不得看到 busy error。唯一有意的兼容变化是 owner 退出后真正取消后台执行。Nano Banana 保持独立 provider admission，可以与本地 GPU pipeline 并行。
- `@shinobu/image-pipeline` 定义可序列化 DTO 及其验证／恢复函数，但不知道 framing。Web adapter 使用 Worker structured clone，扩展 adapter 使用 Chrome Port 与分块传输；chunk、重连和 transport timeout 属于 adapter，结果、进度与 failure 语义不得因 transport 不同而变化。

## 迁移与验证

- 新 package 从第一天起不得反向 import 根实现。迁移期间允许根 `src` compatibility module 重新导出 package API；不允许用 package façade 隐藏对根实现的依赖。
- 先以透明、EXIF、超大图片与多 client 并发夹具固化扩展现有行为，并建立当前 Web 深 import 的 ratchet baseline；然后建立 contract/conformance harness、按依赖闭包移动 package ownership、先切换 Web Worker，再分别迁移扩展 execution 与 background admission，最后删除旧 finalization、协议语义、compatibility re-export 和剩余深 import。
- 旧 Web Worker 与 offscreen host 只有在两个 adapter 通过同一套 execution conformance suite 后才能删除。测试必须覆盖统一结果／record、结构化进度、failure、自动重试、无文本结果、取消单次结算、所有终态的资源释放、扩展 `source-native` 像素兼容、全局 FIFO、断连与重连。
- 架构 guard 在迁移开始时禁止新增 Web 对根 `src` 的深 import，并随迁移逐步收紧；完成时要求 Web 与 `@shinobu/image-pipeline` 对根实现零依赖，同时禁止 package 依赖 `apps/*`。
