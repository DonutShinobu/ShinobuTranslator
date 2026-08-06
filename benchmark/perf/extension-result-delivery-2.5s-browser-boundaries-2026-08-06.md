# 扩展结果交付约 2.5 秒：浏览器边界与可观测性核验

研究日期：2026-08-06

范围：回答浏览器扩展消息、Blob URL、`HTMLImageElement` 加载/解码/呈现的边界，并记录针对约 2.5 秒估算所做的端到端和最小化实验。本文不预测尚未实现的改造能节省多少时间。

## 实验结论（更新）

约 2.5 秒不是本机当前构建中一段可复现的、互不重叠的“结果交付”关键路径。此前的算法大致把约 1.15 秒 PNG/finalize、约 0.35 秒 host 序列化/发送、约 1.04 秒 host-to-visible 相加；但代码和插桩证明，content 侧 `freeze-result` 已经从 PNG 导出前开始，并一直等到 content 收到并重建结果 Blob，因而已经包含 PNG、Base64、两跳 Port 和 content 重建。旧区间存在包含或部分重叠，且原来的“visible”终点早于实际 DOM 应用、图片解码与 paint，不能直接相加。

在 2921×4096、约 7.9 MB PNG 的固定 fixture 上：

| 测量边界 | 结果 | 解释 |
|---|---:|---|
| 实际扩展 `freeze-result`，7 次新 profile | 1259.5–1278.1 ms，中位数 1265.1 ms | PNG 开始到 content 结果 Blob ready，包含整个交付协议 |
| 其中 offscreen `canvasToPngBlob()`，3 次带内部诊断 | 1139.8–1150.3 ms，中位数 1146.4 ms | 占 `freeze-result` 中位数约 91% |
| PNG 完成后的全部剩余工作 | 119.8–127.8 ms | Base64、分块、两跳 Port、content 拼接/解码/Blob 构造、释放的总上界 |
| content 设置最终 Blob URL 后到 `load` | 9.6–12.2 ms | 不是完整解码或显示终点 |
| Blob URL 后到 `img.decode()` | 82.4–169.3 ms | 图片像素可供渲染 |
| Blob URL 后到 Element Timing `renderTime` | 207.4 ms | Chromium 上最接近最终图片可见的浏览器时间点 |
| `freeze-result` 开始到 Element Timing render | 约 1.51 s | 当前可闭合的非重叠“冻结结果到渲染”关键路径 |

实际扩展的 `freeze-result` 阶段在 [`packages/image-pipeline/src/index.ts`](../../packages/image-pipeline/src/index.ts#L767) 调用 finalizer 前开始，直到 finalizer 返回才结束；content 的 [`executeImageTranslation`](../../apps/extension/src/content/core/translation/imageTranslationExecution.ts#L589) 又要等 `executeLocalPipeline()` 返回后才进入 `collect-artifacts`。另一方面，[`startPhotoStateImageTranslation`](../../apps/extension/src/content/core/translation/photoStateProjection.ts#L286) 在创建结果 object URL、调用 adapter 应用图片之前就结束 jank 计时。因此旧计时既把交付子区间重复加到了 `freeze-result` 上，也没有真正测到 visible。

### 最小化实验定位到 Chromium idle-task 超时

为了把产品代码和协议排除掉，又建立了只含一个 offscreen document 和 canvas 的最小扩展。它不加载模型，不生成 Base64，也不建立结果消息链路：

| 同一 offscreen 文档、同一尺寸 | 6 次结果 |
|---|---:|
| `HTMLCanvasElement.toBlob("image/png")` | 首次 1228.5 ms，随后 1133–1146 ms |
| `OffscreenCanvas.convertToBlob({type:"image/png"})` | 1133–1138 ms |
| 同一 HTML canvas 的同步 `toDataURL("image/png")` | 130–142 ms |

另一个普通可见扩展页直接对真实 pipeline 结果 canvas 连续调用 `toBlob()`，首次 149.8 ms，随后 139.4–144.3 ms。这排除了“PNG 编码器首次初始化普遍需要约 1 秒”，也排除了结果内容、模型、Base64、Port 和 content 重建是这 1 秒的来源。HTML canvas 与 OffscreenCanvas 同样慢，还排除了具体 canvas 类型。

Chromium 的 [`CanvasAsyncBlobCreator`](https://chromium.googlesource.com/chromium/src/+/master/third_party/blink/renderer/core/html/canvas/canvas_async_blob_creator.cc) 给出与实验精确吻合的机制：桌面端 idle task 启动超时为 1000 ms；主线程的异步 PNG/JPEG 导出先尝试渐进式 idle encoding；若 idle task 未在超时前启动，则切换到 immediate task 强制编码。最小 offscreen 扩展的约 1.13 秒正好可分解为约 1000 ms 调度等待，加上同一上下文同步路径实测的约 130–142 ms PNG 编码。因此主瓶颈不是 PNG 压缩计算本身，而是 offscreen renderer 中异步 Blob 导出的 idle-task 等待。

以当前约 1.51 秒“冻结结果到 render”链路计算，这一异步 PNG 导出占约 76%；若只看结果 Blob 到达 content 前的 `freeze-result`，占约 91%。第二层成本是浏览器对最终 PNG 的 decode/render，约 0.21 秒；Base64、分块、两跳 Port 和 content 重建合计不超过约 0.13 秒，属于第三层。关闭诊断日志后 `freeze-result` 仍为 1264.7 ms，说明 debug diagnostics 不是主因。

### 修复与复测

修复在 `PipelinePlatform` 增加可选的 `encodeCanvasToPng` 能力，只由扩展的隐藏 browser platform 实现。该实现用同步 `canvas.toDataURL("image/png")` 编码并构造结果 Blob，从而绕过 Chromium `CanvasAsyncBlobCreator` 的异步 idle-task 路径；Web Worker、Node 和未实现该能力的平台继续使用原来的 `toBlob()` / `convertToBlob()` fallback。

Chromium 扩展重新构建后，用同一张 2921×4096 fixture、三次全新 profile 运行真实 UI smoke，content jank 中第一段 `finalize` 分别为 409.4、292.5、308.2 ms，中位数 308.2 ms。与修复前七次端到端 `freeze-result` 中位数 1265.1 ms 相比，下降约 956.9 ms（约 75.6%）；最重要的是原先稳定存在的 1000 ms 平台等待不再出现。三次修复后 `finalize` 的页面侧最大帧间隔不超过 12.6 ms，说明同步工作停留在隐藏 pipeline host，没有阻塞目标页面的渲染线程。

代价是 offscreen host 自身会被同步 PNG 编码阻塞约 0.29–0.41 秒，期间该 host 不能处理取消或 Port 回调；同时 `toDataURL` 会产生完整 Base64 字符串。不过当前协议本来就要生成完整 Base64 并分块发送，因此没有引入新的协议级字符串体积，且实际阻塞显著小于被替换的约 1.14 秒等待。若以后改用 Chrome 148+ structured-clone Blob 或 worker 专用编码器，可再移除此同步路径。

## 浏览器边界结论

此前约 2.5 秒不能作为“PNG + Base64 + 消息传输 + 页面重建”的可加总结果，更不能直接称为“结果到可见”的实测值。旧边界至少混合了以下不同工作：

1. 结果画布 PNG 编码；
2. PNG Blob 读出并生成完整 Base64 Data URL；
3. Base64 分块；
4. offscreen 侧每个 `Port.postMessage()` 调用前的同步 JSON 序列化；
5. offscreen renderer → browser process → background service-worker context 的 IPC、browser UI 线程路由、目标任务调度和 JSON 反序列化；
6. background 监听器执行并再次调用 `postMessage()`，触发第二次同步 JSON 序列化；
7. background renderer → browser process → content renderer 的第二跳 IPC、调度和 JSON 反序列化；
8. content 侧字符串存储、`join()`、`atob()`、逐字节复制、`Blob` 构造；
9. `createObjectURL()`、`img.src` 赋值；
10. Blob URL 取用、图片加载完成、像素解码、样式/布局、paint、composite 和屏幕呈现。

当前代码只观测到了其中一部分。尤其是：

- `Port.postMessage()` 返回不表示目标收到消息；
- `onMessage` 进入前已经发生了 IPC、目标任务排队和反序列化，JS 无法仅靠这一时间点拆开它们；
- `img.src = blobUrl` 返回、`load`、`img.decode()` 和真正呈现在屏幕上是四个不同边界；
- 当前 Twitter `applyImage` 只有同步 `img.src = url`，没有等待 `load`、`decode()` 或 paint；
- 当前 jank monitor 在创建结果 object URL、把 URL 应用到目标图片之前就已经 `finish()`。

本次实验已补上跨 offscreen/background/content/DOM/render 的关键时间线；下面保留各浏览器边界的语义依据，防止后续优化继续使用重叠区间。

## 1. Chrome `runtime.Port.postMessage()` 的实际边界

### 1.1 JS 返回前确定包含什么

Chrome 的公开 API 把 `Port.postMessage` 定义为返回 `void`，并称它是把消息发送到另一端；没有完成回执或可等待的 Promise。[Chrome `runtime.Port` 文档](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-Port)

截至 Chromium `cf6ab69b`，发送路径是：

1. [`GinPort::PostMessageHandler`](https://chromium.googlesource.com/chromium/src/+/cf6ab69b205ae6a8328ff89b1c9d452fd7f138a8/extensions/renderer/api/messaging/gin_port.cc#170) 在调用者 renderer 中执行。
2. 它同步调用 `messaging_util::MessageFromV8()`。
3. JSON 模式下，[`MessageFromV8UsingJSON`](https://chromium.googlesource.com/chromium/src/+/cf6ab69b205ae6a8328ff89b1c9d452fd7f138a8/extensions/renderer/api/messaging/messaging_util.cc#58) 调用 V8 `JSON::Stringify`，再把 V8 字符串转换成 C++ `std::string`。
4. structured-clone 模式下，[`MessageFromV8UsingStructuredClone`](https://chromium.googlesource.com/chromium/src/+/cf6ab69b205ae6a8328ff89b1c9d452fd7f138a8/extensions/renderer/api/messaging/messaging_util.cc#147) 调用 Blink `WebSerializedScriptValue::Serialize`。
5. [`MessageFromV8`](https://chromium.googlesource.com/chromium/src/+/cf6ab69b205ae6a8328ff89b1c9d452fd7f138a8/extensions/renderer/api/messaging/messaging_util.cc#185) 在序列化后检查 64 MiB 上限。
6. [`NativeRendererMessagingService::PostMessageToPort`](https://chromium.googlesource.com/chromium/src/+/cf6ab69b205ae6a8328ff89b1c9d452fd7f138a8/extensions/renderer/api/messaging/native_renderer_messaging_service.cc#397) 调用 Mojo `MessagePortHost.PostMessage`。

因此，围绕单次 `port.postMessage(message)` 的同步计时，确定包含：

- JS→V8/C++ 参数处理；
- JSON stringify 或 structured-clone 序列化；
- 64 MiB 大小校验；
- 调用者一侧把已序列化消息交给 Mojo 的同步路径。

它可能还包含调用者一侧 Mojo 封包/写管道的一部分，但这个比例是 Chromium 实现细节，不能从 WebExtension API 契约单独推断。

### 1.2 JS 返回后仍未完成什么

扩展消息的 Mojo 接口明确分成 renderer→browser 的 `MessagePortHost.PostMessage` 和 browser→renderer 的 `MessagePort.DeliverMessage`。[当前 `message_port.mojom`](https://chromium.googlesource.com/chromium/src/+/cf6ab69b205ae6a8328ff89b1c9d452fd7f138a8/extensions/common/mojom/message_port.mojom#121)

浏览器进程随后还要在 UI 线程执行 [`MessageService::PostMessage`](https://chromium.googlesource.com/chromium/src/+/cf6ab69b205ae6a8328ff89b1c9d452fd7f138a8/extensions/browser/api/messaging/message_service.cc#1189)，查找 channel；channel 若尚未打开还会进入 pending queue。打开的 channel 再经 [`MessageService::DispatchMessage`](https://chromium.googlesource.com/chromium/src/+/cf6ab69b205ae6a8328ff89b1c9d452fd7f138a8/extensions/browser/api/messaging/message_service.cc#1254) 路由到目标 port，最后由 [`ExtensionMessagePort::DispatchOnMessage`](https://chromium.googlesource.com/chromium/src/+/cf6ab69b205ae6a8328ff89b1c9d452fd7f138a8/extensions/browser/api/messaging/extension_message_port.cc#610) 发出 `DeliverMessage`。

目标 renderer 收到后，仍需：

- 调度消息处理任务；
- 在 [`GinPort::DispatchOnMessage`](https://chromium.googlesource.com/chromium/src/+/cf6ab69b205ae6a8328ff89b1c9d452fd7f138a8/extensions/renderer/api/messaging/gin_port.cc#84) 中调用 `MessageToV8`；
- JSON 模式执行 V8 `JSON::Parse`，structured-clone 模式执行 deserialize；
- 构造 JS 值；
- 最后才 dispatch `Port.onMessage` 监听器。

所以发送端 `postMessage()` 返回到接收端监听器第一行之间，是一个聚合黑箱：调用者侧剩余 Mojo 工作、renderer→browser IPC、browser UI 线程排队/路由、browser→renderer IPC、目标 renderer 任务排队、反序列化均可能在内。只用两个 JS 时间戳不能继续细分。

### 1.3 本项目为何是两跳且重复 JSON 成本

当前 Chromium 最低版本仍覆盖 109，之前测量使用的本地 Headless Chrome 是 145；Chrome 官方说明只有 Chrome 148+ 且 manifest 显式设置 `"message_serialization": "structured_clone"` 才切换到 structured clone，低版本或未设置时继续使用 JSON。[Chrome 148 structured-clone 公告](https://developer.chrome.com/blog/structured-clone-messaging)

当前结果路径是：

```text
offscreen host
  -> runtime.Port / JSON stringify
  -> browser process
  -> background / JSON parse
  -> broker listener
  -> runtime.Port / JSON stringify
  -> browser process
  -> content / JSON parse
```

代码证据：

- offscreen 在 [`pipelineHost.ts`](../../apps/extension/src/offscreen/pipelineHost.ts) 中把结果 Blob 变成 Base64、切块并逐块 `postMessage`；
- background 在 [`offscreenBroker.ts`](../../apps/extension/src/background/localPipeline/offscreenBroker.ts) 中收到 host 消息后再次 `clientPort.postMessage(message)`；
- content 在 [`localPipelineClient.ts`](../../apps/extension/src/content/core/translation/localPipelineClient.ts) 中接收、拼接、Base64 解码并构造 Blob；
- Base64 编解码实现位于 [`blobCodec.ts`](../../packages/image-pipeline/src/protocol/blobCodec.ts)，分块/拼接位于 [`protocol/index.ts`](../../packages/image-pipeline/src/protocol/index.ts)。

这说明每个结果 chunk 在 Chrome 145 上至少经过两次 Chrome 内部 JSON stringify 和两次 JSON parse。它不说明这些步骤各用了多少毫秒；必须插桩或抓浏览器 trace。

## 2. Chrome 148 structured clone 与 Blob 能证明什么

Chrome 148+ 的 opt-in structured clone 支持 `File` 和 `Blob`。但官方同时明确：extension messaging 不支持 transferable；`Uint8Array` 会发送副本，`SharedArrayBuffer` 不能用。[Chrome 官方公告](https://developer.chrome.com/blog/structured-clone-messaging)

File API 把 Blob 定义为 serializable object；序列化/反序列化步骤传递 snapshot state 和 underlying byte sequence。[File API：Blob serialization](https://w3c.github.io/FileAPI/#blob-section)

这些来源只足以证明：Blob 可保持为 Blob 类型穿过 structured-clone 消息。它们不能证明：

- extension Port 的 Blob 是零拷贝；
- Blob 字节不会跨进程搬运；
- 本地 `structuredClone(blob)` 的耗时等于 runtime.Port 的耗时；
- Blob 路径一定比当前 Base64 路径快多少。

Chromium 的 extension messaging 把 structured clone 放在 `blink.mojom.CloneableMessage` 中，并仍经过 browser process 路由；具体 Blob backing store、Mojo attachment 和跨进程复制行为属于实现细节，需要 Chrome 148+ 的端到端 trace/基准确认。

Firefox 的 WebExtension 消息使用 structured clone，MDN 的兼容性文档把 `runtime.Port.postMessage()` 明确列入该组 API。[Mozilla WebExtension 数据克隆说明](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#data_cloning_algorithm) 但同样不能由“使用 structured clone”推导为零拷贝或某个固定时延。

## 3. `img.src = blobUrl` 之后的加载、解码和呈现边界

### 3.1 `createObjectURL()`

File API 规定 `URL.createObjectURL(blob)` 的核心动作是向浏览器的 Blob URL store 添加一个指向该 Blob 的条目并返回 URL；Blob URL 被解引用时再通过 Blob URL store 找到资源。[File API：Blob URL model](https://w3c.github.io/FileAPI/#blob-url) [File API：create/revoke](https://w3c.github.io/FileAPI/#creating-revoking)

因此 `createObjectURL()` 返回只代表 URL 引用已创建，不代表：

- `<img>` 已开始或完成加载；
- PNG 已被像素解码；
- 图片已进入 layout/paint/composite；
- 用户已经看到新帧。

规范也不要求该调用复制整份 Blob；但规范算法是抽象行为，同样不能据此断言实现为零拷贝。

### 3.2 `load` 事件

HTML Standard 的图片处理模型在资源获取完成后把 image request 置为 `completely available` 并触发 `load`。这里的 `completely available` 只要求已经取得全部数据且至少能得到尺寸；“fully decodable”是另一个条件。[HTML Standard：image request states](https://html.spec.whatwg.org/multipage/images.html#img-req-state) [HTML Standard：更新图片数据](https://html.spec.whatwg.org/multipage/images.html#updating-the-image-data)

HTML Standard 甚至明确给出：在 `load` handler 里把图片插入 DOM，随后的 paint 仍可能在主线程做同步 decode 并造成掉帧。[HTML Standard：`decode()` 示例](https://html.spec.whatwg.org/multipage/embedded-content.html#dom-img-decode-dev)

所以 `load` 是“资源加载完成并可用”的边界，不是“完整像素解码完成”，也不是“已经 paint/present”。

### 3.3 `HTMLImageElement.decode()`

`img.decode()` 返回的 Promise 在图片完成解码、数据可供使用后 resolve；规范要求浏览器尽量把已解码数据保持到下一次成功的 update-the-rendering 结束。[HTML Standard：`decode()`](https://html.spec.whatwg.org/multipage/embedded-content.html#dom-img-decode-dev) [MDN `HTMLImageElement.decode()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode)

因此它是最合适的 JS 图片解码完成边界，但 resolve 本身仍不代表该图片已经在屏幕上呈现。之后还可能有 DOM/style/layout、paint、raster、composite 和 display presentation。

### 3.4 `requestAnimationFrame()`

`requestAnimationFrame` callback 在下一次 repaint 之前调用。[MDN `requestAnimationFrame`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)

所以：

- 在 `img.src` 后等待一个 rAF，只能说明浏览器来到了某次更新前的 callback；
- callback 内读取 `performance.now()` 不是该帧 paint 或 presentation 的时间；
- 双 rAF 常被当作近似“至少跨过一个渲染机会”，但规范仍没有把第二个 callback 定义成前一帧已经物理显示的确认。

### 3.5 真正接近“用户可见”的 JS 时间点

普通 `PerformancePaintTiming` 只定义页面的 first paint 和 first contentful paint，不能测一次运行中的图片替换。[Paint Timing](https://w3c.github.io/paint-timing/)

Chromium 支持 Element Timing。给目标 `<img>` 提前加唯一的 `elementtiming` 属性，并用 `new PerformanceObserver(callback).observe({type: "element", buffered: true})` 观察，`PerformanceElementTiming` 同时提供 `loadTime` 和 `renderTime`；规范把 `renderTime` 定义为默认 paint timestamp。[Element Timing](https://w3c.github.io/element-timing/)

当前 Paint Timing 草案进一步区分：

- `paintTime`：update-the-rendering 循环结束；
- `presentationTime`：实现提供的、帧实际呈现给用户的时间；
- 默认 paint timestamp 优先使用 `presentationTime`，没有时退回 rendering update end time。[Paint Timing：PaintTimingMixin](https://w3c.github.io/paint-timing/#paint-timing-mixin)

注意：Element Timing 当前只在 Chromium 系浏览器实现；需要先通过 `PerformanceObserver.supportedEntryTypes.includes("element")` 做能力检测。还要在本项目实际 content-script isolated world 和动态换 `src` 场景中验证是否产生预期 entry，不能只根据规范假设。

Firefox 端没有 Element Timing；若需要确认最终帧，应使用 Firefox Profiler 的多进程 timeline/IPC markers，并辅以截图或视频时间线。[Firefox Profiler](https://profiler.firefox.com/docs/) Firefox 官方资料说明 IPC、Runnable 和 Task 已记录 flow markers；标准 Profiler UI 的 flow 可视化仍在推进，官方文档指向了可显示它们的预览界面，不能假设任意版本 UI 都能直接画出完整因果链。[Firefox profiler marker 指南](https://firefox-source-docs.mozilla.org/tools/profiler/markers-guide.html)

## 4. 当前 ShinobuTranslator 的显示终点实际在哪里

当前代码路径的重要顺序是：

1. content client 完成 Base64 拼接/解码并构造结果 Blob；
2. `executionTask.result` resolve；
3. [`startPhotoStateImageTranslation`](../../apps/extension/src/content/core/translation/photoStateProjection.ts#L245) 的 `.then()` **先调用 `finishJank()`**；
4. [`applyImageTranslationResult`](../../apps/extension/src/content/core/translation/photoStateProjection.ts#L156) 创建 Blob URL 并写入 `state.translatedUrl`；
5. 外层 [`ImageTranslationController.handleTranslateClick`](../../apps/extension/src/content/core/translation/imageTranslationController.ts#L115) await task 后才调用 adapter `applyImage`；
6. Twitter adapter 的 [`applyImage`](../../apps/extension/src/content/adapters/twitter.ts#L624) 仅执行 `target.element.src = url` 等同步 DOM 操作。

由此可得：

- local pipeline 的“result complete”最多到“结果 Blob 已在 content JS 中重建”；
- jank report 的 finish 甚至早于结果 object URL 创建；
- controller Promise 完成/`applyImage` 返回最多到 `src` 已赋值；
- 当前没有任何产品埋点证明 `load`、decode、paint 或 presentation 的完成时间。

因此，任何以这些现有终点命名的 `host-to-visible` 都需要改名。若终点是 content client result，应叫 `host-post-return → content-result-blob-ready`；若终点是 adapter 返回，应叫 `... → img-src-assigned`。只有 Element Timing `renderTime`、浏览器 trace presentation marker，或与其校准过的视觉采样，才接近“visible”。

## 5. 把约 2.5 秒拆清楚所需的最小测量

### 5.1 统一时钟

offscreen page、background service worker、content document 有不同的 `performance.now()` time origin。应在每个上下文记录：

```ts
const absoluteNow = () => performance.timeOrigin + performance.now();
```

High Resolution Time 规范和 MDN 都明确用 `performance.timeOrigin` 平移跨 Window/Worker 的时间戳。[High Resolution Time](https://w3c.github.io/hr-time/#sec-time-origin) [MDN `performance.timeOrigin`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/timeOrigin#synchronizing_time_between_contexts)

不要混用 `Date.now()` 和 `performance.now()`；也不要直接比较不同 context 的裸 `performance.now()`。

### 5.2 必须记录的时间点

| 标记 | 上下文 | 精确定义 | 可计算区间 |
|---|---|---|---|
| `h_png_start/end` | offscreen | `convertToBlob({type:"image/png"})` await 前后 | PNG 编码 Promise 的端到端时间 |
| `h_b64_start/end` | offscreen | `blobToBase64` await 前后 | Blob 读出 + Data URL/Base64 生成 + 回调调度 |
| `h_split_start/end` | offscreen | `splitBase64Chunks` 前后 | JS 分块同步时间 |
| `h_post_begin/return[i]` | offscreen | 每个 `port.postMessage` 调用前后 | 第一跳发送端同步序列化/校验/提交，不是传输 |
| `b_recv[i]` | background | broker listener 第一条语句 | 从 host post begin/return 到 background 已反序列化并获调度的聚合时间 |
| `b_post_begin/return[i]` | background | relay `postMessage` 前后 | 第二跳发送端同步序列化/校验/提交 |
| `c_recv[i]` | content | client listener 第一条语句 | 第二跳 IPC + 排队 + content 反序列化的聚合时间 |
| `c_join_start/end` | content | assembler `complete()` 前后 | Map/数组读取和完整字符串拼接 |
| `c_decode_start/end` | content | Base64→bytes→Blob 前后 | `atob`、逐字节复制、Blob 构造 |
| `c_url_created` | content | `createObjectURL` 返回后 | Blob URL 注册完成 |
| `c_src_assigned` | content | `img.src = url` 返回后 | DOM 属性同步更新完成 |
| `c_img_load` | content | 一次性 `load` listener 第一条语句 | 资源 completely-available + load task 调度 |
| `c_img_decoded` | content | `await img.decode()` resolve | 完整像素 decode 可用 |
| `c_img_render` | content/UA | 匹配 job 的 Element Timing `renderTime` | Chromium 的默认 paint/presentation timestamp |

还应随每个 chunk 记录 `jobId`、`seq`、payload 字符数、总 chunk 数，才能看到：

- 第一块在 host 仍发送后续块时，是否已被 background/content 处理；
- 两跳是否流水化；
- background 是在第一跳排队还是第二次 stringify 上阻塞；
- content 是在等最后一块，还是在最后一块后做大字符串/byte copy；
- 各阶段相加时是否发生重叠，避免重复计时。

### 5.3 浏览器 trace 用来拆 JS 黑箱

JS marks 可以把 2.5 秒切成“sender sync”“跨边界到 listener”“content 重建”“图片 decode”“render”等大段；但第一/二跳的 browser-process 路由、各 renderer task queue、IPC copy/共享内存、JSON parse 内部仍需要浏览器 trace。

Chrome 官方 tracing 文档说明 tracing 会记录多个 Chrome 进程的线程活动，适合识别瓶颈和跨进程事件。[Chromium Trace Event 工具](https://www.chromium.org/developers/how-tos/trace-event-profiling-tool/) DevTools Performance panel 可同时查看 Main track、GPU track 和截图；可用 `console.time/timeEnd` 或 User Timing 把上述 jobId 区间叠到 trace 上。[Chrome DevTools Performance reference](https://developer.chrome.com/docs/devtools/performance/reference)

一次有效证据包至少应包含：

- 同一 fixture、同一构建、同一 Chrome 版本的 5 次冷进程运行；
- 每次的统一时间线 JSON；
- 其中至少 1 次 Chrome trace + filmstrip；
- 原始 PNG 字节数、Base64 字符数、chunk 数；
- 页面前台且尺寸/缩放固定；
- debug image 关闭与开启分开测；
- 报告 median，并保留每次 run，不能只报告平均数。

## 6. 不能从现有 JS timing 推出的结论

以下表述目前都没有足够证据：

- “`postMessage()` 花了 X ms 传到 background/content。”发送调用只量到发送端同步工作。
- “发送循环结束时，所有 chunk 已经离开 offscreen 进程。”API 不提供这个保证。
- “`postMessage` 返回到 `onMessage` 的差值就是 IPC。”它还包含 browser/renderer 排队和目标反序列化。
- “background relay 很快，所以第二跳没有成本。”relay `postMessage` 返回不等待第二跳完成。
- “`load` 时图片已经显示。”`load` 不是 decode/paint/presentation 完成点。
- “`decode()` resolve 时用户已经看到图片。”decode 与后续 rendering/presentation 分离。
- “一次/两次 rAF 后一定已显示。”rAF callback 在 repaint 之前；双 rAF 只是近似。
- “本地 `structuredClone(blob)` 近乎 0 ms，所以 extension Port 传 Blob 也近乎 0 ms。”后者有序列化、Mojo、browser 路由和目标反序列化。
- “Blob structured clone 是零拷贝。”规范和 Chrome 公告均未给这个保证。
- “2.5 秒全部是传输税。”其中可能包含发送端序列化、两端排队、接收端重建和图片 decode/render；现有计时还没有覆盖真正 presentation。
- “把各 chunk 的耗时相加就是关键路径。”不同进程可能流水化，区间可能重叠。

## 7. 研究后对约 2.5 秒的准确表述

建议把此前结论改为：

> 此前约 2.5 秒来自重叠区间的错误相加，不是独立的结果交付实测。当前固定 fixture 上，从 `freeze-result` 到 content 结果 Blob ready 约 1.27 秒，其中约 1.15 秒是 offscreen canvas 异步 PNG Blob 导出；最小复现和 Chromium 源码共同指向 1000 ms idle-task 启动超时。再计入 DOM 应用和 Chromium Element Timing 上报的最终图片 render，非重叠关键路径约 1.51 秒。Base64、分块、两跳消息及 content 重建合计不超过约 0.13 秒，不是当前主瓶颈。

这组结论适用于当前本机、Chrome 145、当前 fixture 和构建。不同图片尺寸、浏览器版本、前后台状态和机器性能仍需按相同边界重新测量；但“旧 2.5 秒不可相加”和“当前主要耗时发生在 offscreen 异步 PNG 导出”已经由代码包含关系、端到端计时、最小复现、同步对照组及 Chromium 实现五类证据交叉验证。
