# 冷启动预算：像素处理、阅读顺序与交付实验

日期：2026-10-01。实验工作树：`cold-start-budget`，Chromium，当前模型和 float32 推理保持不变。

## 当前阶段与目标

全程首图基线可见结果中位数 5691 ms，目标 2845 ms，排除外部翻译。
该图片 2921 × 4096，像素阶段代表样本为 mask 231 ms、inpaint 533 ms、order 125 ms、PNG + 交付 318 ms、display 126 ms。
这些阶段中大量时间属于 Canvas、编码、推理，不能全部通过 JS 循环优化消除；本组无法独立提供需要的 2846 ms 节省。

## 可启用候选

所有开关默认 false；只需在 offscreen / pipelineHost 的全局上下文设置，不需要 worker 侧开关。

| 开关 | 候选 | 保持的语义 |
| --- | --- | --- |
| `__shinobuColdStartPixelFastPath` | 完整非 debug 流程跳过 detection/OCR 两张预览 Canvas | 最终去字/排版结果仍从 original 和模型结果生成；stopAfter=order、typesetDebug、eraseDebug、collectDebugLog 保留预览 |
| 同上 | PNG Blob 在 WeakMap 中保留 toDataURL 已生成的 base64，blobToBase64 直接复用 | PNG 编码和 Blob 的字节不变；任意其他 Blob 保留 FileReader 路径 |
| 同上 | mask connectedComponents 从已有 BFS queue.slice 得到 pixels，省去 number[] 逐个 push | 分量发现、8 邻域、BFS 像素顺序、面积和矩形完全不变 |
| 同上 | 二值遮罩用 Uint32Array 一次写完整 RGBA | 保留 Canvas 平滑插值、红通道 >127 阈值、输出尺寸和 alpha=255；端序来自 [0,0,0,255] 的原生视图；未对齐数据回退原路径 |
| 同上 | readingOrder 的 7 项 Gaussian 展开内部像素，第二遍按行提前计算 clamped 行地址 | 相同 1/6/15/20/15/6/1 权重、累加顺序、除64、Float32 临时图、Math.round 和边界扩展；1800 最大边长、阈值、面板/文字排序未改 |
| `__shinobuColdStartInpaintPixels` | 去掉 getImageData 后额外的 RGBA typedarray 复制；全图二值 CPU mask 改 Uint8；合成用 Uint32 像素复制再置 alpha=255 | 所有 Canvas 缩放、>127 mask 阈值、512 输入、模型 feeds float32、模型输出解码/舍入保持原路径 |
| `__shinobuColdStartInpaintProfile` | 分别记录 setup/preprocess/modelRun/decode/readOriginal/readMask/resize/compose | 仅开启时调用 performance.now 并打印 `[shinobu:inpaint-profile]` JSON |

预览的所有提前结束已核对：detect 无区域、OCR 无区域、无可翻译文字都重置 resultCanvas=original；stopAfter=order 保留原预览；异常直接 throw，不 finalize 图像。正常完整路径最终 resultCanvas 必定经过 inpaint，再经 typeset 或 erase 分支设置。

## inpaint 调用链和静态内存节省

`runInpaint` → readModel/getSession → source/mask Canvas 缩放到512 → float32 feeds → modelRuntime.run → Float32 输出解码 → 原图/全图 mask 读取 → 修复 RGBA 放大到原尺寸 → 按二值 mask 合成 → putImageData。

`modelRun` 包含首次着色器编译、推理、输出下载与 RPC，当前细分不会将它们重复计作像素收益。

2921 × 4096 每幅全图 RGBA 为 47,857,664 bytes（45.6 MiB）。inpaint 候选少分配两份全图 RGBA clone 和一份512 RGBA clone，共96,763,904 bytes；全图0/1 mask 从47,857,664 bytes降到11,964,416 bytes，再少35,893,248 bytes。每次共避免约126.5 MiB 临时数组分配，不含预览 Canvas 约91.3 MiB 的额外表面。这里只是分配量，不是耗时节省。

没有删除 full-size Canvas drawImage/getImageData：这样可保持浏览器原有插值/颜色/alpha 往返的结果，优先避免明确多余的 typedarray 复制。

## 可复跑检查

```powershell
npx tsx benchmark/perf/src/check-cold-budget-pixels.ts
npx vitest run tests/pipeline/orchestrator.test.ts --maxWorkers=1
npm run typecheck:benchmark
```

已通过：

- Gaussian 从 1×1、2×3、3×2、5×7、8×9、61×47 到1284×1800，逐字节相同。
- 三组稀疏/稠密 mask 的 connectedComponents 包括 pixels 顺序在内完全相同。
- 遮罩32位转换与旧路径逐字节相同；此检查用模拟 Canvas 返回覆盖0..255的红通道，不代替真实浏览器的插值与全图 hash 检查。
- inpaint mask Float32 与 Uint8 的每个二值元素相同；模型 float32 feeds 未改。合成检查包含不同 RGB/alpha、0/0.49/0.5/1/NaN mask，以及未对齐输入回退，最终 RGBA 相同且 alpha 全为255。
- PNG Blob ArrayBuffer 字节相同，缓存 base64 等于原 toDataURL 字符串，非缓存 Blob 仍走 FileReader。
- 预览门限、完整结果、debug 预览、stopAfter=order 由现有 orchestrator suite 新增一项检查；13项全部通过。
- benchmark TypeScript 检查通过。

现有 `canvas` 安装缺少原生 `canvas.node`，未增加/安装依赖，CPU 检查改用数组和模拟 Canvas。真实 Chromium 质量门由 root 串行实验执行：主 fixture 最终 RGBA SHA-256 必须仍为 `d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97`。

单次 CPU 检查仅用于发现候选：1284×1800 Gaussian 335.6→29.1 ms，稀疏大图分量22.6→19.8 ms，含模拟 Canvas 的 full-size mask 转换138.3→117.9 ms。不同 JIT/上下文与浏览器阶段不可直接相减，不能将335.6−29.1从仅125 ms的浏览器 order 阶段扣除。最终收益以相邻 Chromium A/B 全程中位数和阶段细分为准。

## 追加质量样本建议

工作树仅有一幅漫画 fixture。主 fixture 外建议做三个明确边界样本：无文本图片（可用现有 icon128.png）、含 alpha/透明边缘的 PNG（验证合成不改变既有 alpha=255 规则）、同一漫画 fixture 的原文与去字模式分别 A/B。新增实验图仅用于质量边界，不作为降低分辨率或更换模型的性能方案。

## 独立两轮全流程结果与只读审计

来源：`.tmp/cold-budget/1790845479924-results.json`，每个新 profile 运行冷首图及同 Worker 的第二张。

| 候选 | 首图可见结果，两轮(ms) | 同 Worker 第二张，两轮(ms) |
| --- | --- | --- |
| baseline | 5261 / 5568 | 2126 / 2385 |
| pixels | 7936 / 7622 | 3138 / 3186 |
| inpaint | 7459 / 5144 | 3155 / 2073 |

**像素组合没有证明加速，当前不可计入2845 ms预算。** pixels 两轮全程均慢于 baseline；inpaint 波动明显，目前不能声称全程收益已经稳定。

已核对12个样本：模型都为 WebGPU，无推理 fallback；冷 OCR 为9次调用、2,162,304 input bytes / 35,099,960 output bytes，第二张为8次、2,174,976 / 35,324,480；相同 bucket、默认 session options、17个accepted、0 rejected/missing、0 post-filter删除。
剔除随机region id后，将17个OCR区域的 geometry、direction、inputDims、resizedWidth、decodedText、confidence、accepted 编码为JSON，其冷样本SHA-256均为`15748F8FF442C10BE498B7998D83A1469DDE1E6360259B0DA0755F9AC0672B8C`，同Worker第二张均为`0B60F7E45D894F23AE826338AE460A891CF49CAF895A8B3B51F1503DF8CAA523`。
全部最终RGBA hash保持主fixture基线。冷/第二张的OCR归一化hash不同是现有coldFirstSerial宽度/batch安排差异，候选之间一致。

退化定位与限制：

- pixels 的 detector preload 为1357/1276 ms，而baseline为846/947 ms。在这个阶段，像素实验仅执行过一个`collectStagePreviews`布尔判断，预览、mask、卷积、base64候选尚未执行。因此前置330–510 ms退化不能由新增像素循环或模型调用数量解释。
- OCR纯CPU预处理 baseline约53–58 ms，pixels约84–89 ms；颜色采样约37→60–69 ms。输入规模一致，整体执行速度变化是真实测量现象，但当前没有充分证据判定其环境原因。
- order baseline125/127 ms，pixels122/136 ms，未体现CPU微基准的大幅绝对收益。不能将CPU check中的306 ms差值记作浏览器收益。
- 需要注意真实候选副作用：跳过预览可能失去字体/Canvas预热；WeakMap使当前PNG base64与Blob共同驻留；新 queue.slice/Uint32 分支需要JIT优化。它们可能影响后半程的CPU/GC，但都发生在前置preload之后，不能解释整条退化。
- A/B runner在每轮变体上由同一originals Map重写prefix，finally恢复，未发现前一变体开关累计。构建产物包含所有候选分支；报告尚未捕获全局开关或每个分支的实际计数，细分收益还需验证。

保留CPU质量检查通过的结论，撤销将微基准作为全流程收益证据的任何解释。各候选与组合应由root统一串行测量，不把不同线程、重叠阶段或背景变化直接相加。

## 最后一个候选：直接读取与复用原图副本

独立开关 `__shinobuColdStartInpaintDirectPixels`，默认false，不修改`InpaintPixels`单独开关的A/B定义。原图直接从自身2D context读取；mask仅在请求尺寸与自身尺寸相同时直接读取，保留>127阈值；合成复用原图`getImageData`返回的独立ImageData对象，不再分配另一份全图RGBA。原Canvas不被写入。

root组合最新细分中 modelRun约45 ms，readOriginal/readMask/resize/compose分别约50/69/59/32 ms；慢轮推理仍约45 ms，CPU部分约60/94/77/63 ms。最后候选针对前两项和合成分配，不会再将shader预编译收益记入其中；放大Canvas路径保留。

CPU复制/原位合成检查与typecheck已通过。原生质量门由root执行：

```powershell
npx tsx benchmark/perf/src/check-inpaint-direct-pixels-browser.ts
```

它不加载模型，使用实际私有像素函数，在原生GPU/CPU Canvas × 不透明/半透明 × InpaintPixels开/关，共8个组合上比较读取、mask二值、最终RGBA并确认源Canvas未修改。必须全部逐字节一致，再过主漫画完整模型输出hash；任一失败则不保留候选。此文件记录实现就绪，不声明原生质量门或速度门已通过。

[WHATWG Canvas规范](https://html.spec.whatwg.org/multipage/canvas.html)说明半透明像素经过颜色空间/预乘alpha转换可能有舍入损失，不能仅从API形状推导直接读与Canvas复制读等价；因此上述半透明原生检查是必要门限。

## 追加交付候选：原生 Blob Port 协议

root 后续串行实验确认：上述8组原生 Canvas 检查通过，主漫画组合最终 RGBA 仍与基线相同。当前 all-direct-latefonts 两轮 fresh 中位数3631.9 ms，cached2651.7 ms；这是组合测量，不是对独立 pixels 候选收益的追认。fresh 交付353.65 ms已含 PNG196.95 ms，再加显示264.92 ms，共618.57 ms。

此前 Playwright Chromium145 默认JSON，Blob不能直接经 Port。2026-04-22发布的[Chrome官方说明](https://developer.chrome.com/blog/structured-clone-messaging)确认从Chrome148开始，可在manifest设置`message_serialization: "structured_clone"`，全扩展消息支持File/Blob；旧版或未设置时仍是JSON。它不支持所有权transfer，typedarray仍复制，不能称作整个流水线零拷贝。实际收益须在相同新版浏览器上比较JSON与structured clone，不能把浏览器升级计入优化。

默认关闭开关：`__shinobuColdStartStructuredClone`。需要同时启用content、background、offscreen/pipelineHost三个上下文；manifest实验切换由root的runner负责，生产manifest未改。

| 环节 | 最小协议变化 | 保留的约束 |
| --- | --- | --- |
| prepare/ready | client发1-byte Blob probe；broker实收到Blob才回复`structuredClone:true` | broker先回复ready，不能等host admission才协商；JSON收到`{}`或未确认时回退Base64 |
| input | `start.binaryFile`直接带File；`input`声明零块/零字符，然后照常`input-complete` | 原有FIFO、Promise<File>、取消、文件metadata不变；实际Blob.size必须等于metadata |
| output | host等`task.result`（结果和debug PNG全部编码完成），`result-meta.resultBlob/debugBlob`带Blob和零块metadata，再照常`complete` | PNG同步编码路径未改，没有将编码推迟到导出时；未协商或格式/type错误会失败 |
| display/export | client返回同一个`LocalPipelineResult.result:Blob` | 仍由content创建自己的ObjectURL，原显示、下载、URL撤销和页面状态寿命路径不变 |

Blob接收对象由content持有，host取消/关闭释放自己的引用；这里不把offscreen的ObjectURL跨来源交给页面，因此无需新建URL租约/iframe/跨分区读取协议。packed detection mask仍沿用已有Base64小字段，检测预检路径保持原协议。

CPU检查已通过（2026-10-01 18:18）：

```powershell
npx vitest run tests/shared/localPipelineProtocol.test.ts tests/content/core/localPipelineClient.test.ts tests/background/offscreenBroker.test.ts tests/offscreen/pipelineHost.test.ts --maxWorkers=1
npm run typecheck:extension
npm run typecheck:tests
```

4套suite共57项通过；随后将Promise<File>取消测试同时覆盖native/legacy，client suite9项再次通过（累计58项）。覆盖真实probe与JSON-object回退、零块仍必须complete、输入bytes/metadata一致、输出与debug PNG两者都完成后才交付、Native Blob bytes和现有类型API保留、未经协商/伪Blob/size/type/混合块格式失败，以及取消、端口断开、FIFO和idle清理。

root后续在原生Chromium151确认四层握手能力为true，input/result chunks为0，输入Blob7,915,903 bytes，结果PNG Blob7,988,558 bytes，主图最终RGBA hash不变。诊断报告`.tmp/cold-budget/1790850878014-results.json`中的组合交付约455→243 ms，后者PNG232 ms；组合含其他候选，因此这个差值不能单独当作SC独立全程收益。速度仍以同版本JSON/SC交替实验为准，不可将618.57 ms整个阶段计作可消除时间。

## 追加 PNG 候选：同尺寸 OffscreenCanvas 导出

独立开关`__shinobuColdStartOffscreenPng`，默认false，仅需offscreen/pipelineHost上下文。`browserPipelinePlatform.encodeCanvasToPng`以原宽高新建OffscreenCanvas，2D `copy`合成模式按(0,0)绘制原Canvas，无缩放，再等`convertToBlob({type:'image/png'})`完成后清空临时surface。未提供OffscreenCanvas时保留同步原路径；未改字体marker、pipeline finalize或返回Blob的API。

目标是避开现有同步`toDataURL`的Base64生成/解析以及HTMLCanvas`toBlob`在扩展offscreen中已观察到的idle等待；这是待测候选，不保证OffscreenCanvas实现没有等待。它增加一幅原尺寸Canvas表面（主fixture约45.6 MiB），PNG仍完整编码再交付，不能把异步编码期间转到后台的工作算作省略。与SC一起启用时可让结果编码/交付整段不经过Base64；单独开启时旧JSON Port仍需现有FileReader/Base64协议。

CPU2项已通过，extension/benchmark typecheck通过。CPU测试确认默认和能力缺失回退、宽高与draw位置不变、完整Blob Promise完成后才释放surface，并确认原Canvas未改变。像素质量和时间由root运行实际浏览器check：

```powershell
$env:COLD_BUDGET_BROWSER = '实际测试浏览器的绝对路径'
npx tsx benchmark/perf/src/check-offscreen-png-browser.ts --rounds=3
```

该check从源码取得实际encoder及现有blobCodec，未加载模型；GPU/CPU Canvas × tiny/opaque/alpha/debug/no-text/2921x4096 fixture共12组合。比较PNG签名、解码尺寸、逐字节decoded RGBA（包含alpha0..255）、原Canvas前后像素；对同一Canvas交替编码，计时一直覆盖完整PNG完成及候选surface释放。可传`--fixture=路径`检查保存的最终译图。

编码微基准只供归因：它包含重复编码和质量读取产生的预热，不能替代真实扩展首次最终图的finalize、delivery和visible全程测量。任一decoded RGBA不一致则不能启用；PNG压缩字节/文件大小可以不同，但解码内容必须相同。

root已在原生浏览器运行12组质量门，全部通过，包括alpha0..255、debug、no-text与主图。三轮同Canvas微基准主图GPU canvas中位数256.3→193.7 ms，CPU canvas227.4→201.3 ms；简单图约慢1 ms。这仅证明像素一致与前台编码候选，并未通过真实扩展速度门。

## Offscreen PNG 真实后台退化

完整流程QA来源`.tmp/cold-budget/1790852190658-results.json`与`reports/ui-jank-2026-10-01T10-56-49-072Z.json`。主图最终RGBA hash仍相同，但PNG finalize为1197 ms，结果交付1205.1 ms，显示尾部275.1 ms。offscreen host的finalize progress在3380.2 ms，result-meta在4578.8 ms，相差1198.6 ms；meta到content6.7 ms，complete到content0.7 ms。此次交付退化主要在生成PNG，Blob Port开销仍小。

host同步前段最后一个longtask结束于3405.4 ms，后一个longtask开始于4406.8 ms，期间1001.4 ms无记录的长任务；随后执行170 ms长任务并交付PNG。这与[精确Chromium151.0.7922.34的CanvasAsyncBlobCreator源码](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/core/html/canvas/canvas_async_blob_creator.cc)中的Windows1000 ms idle启动超时吻合。源码表明主线程PNG编码仍选idle，不会因Canvas名为OffscreenCanvas自动换到Worker；超时后ForceEncodeRows强制编码。trace未直接记录native函数，故这是有源码支持的归因推断。

**OffscreenPNG当前不计入50%预算。** 原同步编码+SC路径保持为正常性能组合，root另做真实offscreen A/B确认；不将前台63 ms编码收益宣称为扩展全程收益。源码还明确Worker线程convertToBlob直接编码而不等待idle，后续若要继续实验需将像素快照交给独立Worker并重新过alpha/颜色/尺寸质量门。当前未扩展此候选，也未改变结果显示方式。

## PNG 完成到 DOM 显示的只读审计

产品路径为`localPipelineClient`返回Blob → `photoStateProjection.replaceUrl`在内容页创建ObjectURL → `screenshotOverlay.renderScreenshotResultUi`为img赋src。相同URL有src比较守卫，重复通知/渲染不会重设src。普通站点adapter也直接替换img.src，未发现最终PNG在产品中经过第二次显式解码或Canvas拷贝。

现有benchmark的`image.decode()`及下一次RAF定义显示终点；之后用于最终RGBA hash的第二次decode/Canvas读取发生在终点时钟之后，不属于显示尾部。151诊断中host result-meta到content约8.6 ms，complete约0.3 ms，display仍285 ms；剩余主要落在图片加载、解码请求及呈现调度范围，缺少内部时钟时不能将285 ms都称为PNG解压CPU时间。

[`img.decode`规范](https://html.spec.whatwg.org/multipage/embedded-content.html)让Promise等待图像可用并完成解码；[decoding提示规范](https://html.spec.whatwg.org/multipage/images.html#decoding-images)描述呈现调度取舍，不能据此保证`decoding=async`缩短同一PNG完成解码到下一RAF的总时长。当前不因这些提示改产品路径。

最小诊断helper：`benchmark/perf/src/cold-start-display-probe.mjs`，由root传入已经启动的Playwright页面与扩展ServiceWorker，不启动浏览器或模型，不改产品/runner：

```js
import {
  installColdStartDisplayProbe, readColdStartDisplayProbe,
  disposeColdStartDisplayProbe, checkResultBlobAfterOffscreenClose,
} from './benchmark/perf/src/cold-start-display-probe.mjs';

// 在单独诊断轮开始前安装，现有benchmark watcher继续调用decode。
await installColdStartDisplayProbe(page);
// ……执行原pipeline，等原有完整PNG + decode + RAF门……
const displayTimeline = await readColdStartDisplayProbe(page);
await disposeColdStartDisplayProbe(page);

// 只在时钟与完整主图RGBA门之后执行，会关闭现有offscreen宿主。
const lifetimeGate = await checkResultBlobAfterOffscreenClose(page, worker);
```

显示probe观察原有decode Promise且返回原Promise对象，不发起额外decode；记录src观察、load事件、decode开始/完成与下一RAF，派生`srcToLoadMs/srcToDecodeMs/decodePromiseMs/decodeToRafMs`及`decodeCalls`。src时钟来自主页面MutationObserver/decode时观察，非内容脚本isolated world的精确setter时间；RAF也不等同屏幕扫描输出。诊断轮与正式A/B分开，避免探针对计时造成干扰。

生命周期门先读取内容页原BlobURL，验证PNG与新Image解码的RGBA hash，然后通过ServiceWorker关闭唯一offscreen宿主并核对contexts变0；再次用同一内容BlobURL读取PNG、创建新URL/新Image解码。URL/type/bytes/PNG SHA-256/decodedRGBA SHA-256/尺寸都必须一致。仅撤销测试新建URL，保留产品原URL，可同时验证host关闭后的显示与下载字节寿命。

helper已通过`node --check`和6段生成evaluate字符串的CPU语法解析。root在原生Chromium151运行了显示细分与生命周期门，见`.tmp/cold-budget/1790852880597-results.json`及`reports/ui-jank-2026-10-01T11-08-21-462Z.json`：src观察到load12.7 ms，decode Promise234.3 ms，decode到下一RAF6.1 ms，hash前decodeCalls=1。此轮尾部主要落在native decode Promise等待，不能归因于产品重复解码，也不能只凭Promise时长进一步区分PNG解压与浏览器解码队列。

关闭唯一offscreen后，原内容BlobURL仍可fetch；PNG bytes/type/SHA-256、新Image解码RGBA/尺寸全部一致，主图RGBA仍为上述严格hash。生命周期门通过，测试读取/hash/解码耗时没有计入冷启动收益。

## 追加 PNG Worker 候选

独立开关`__shinobuColdStartWorkerPng`，默认false，仅需offscreen/pipelineHost上下文；优先于旧`OffscreenPng`，不需同时开启旧候选。私有`shared/pngWorkerEncoder.ts`创建直接同源的短module Worker，Vite静态`new Worker(new URL(...), {type:'module'})`打包为独立asset，符合现有`worker-src 'self'`；未扩展PipelinePlatform公开API、Port协议、manifest、ONNX Worker或产品显示。

默认路径`createImageBitmap(originalCanvas)` → transfer ImageBitmap → Worker同尺寸OffscreenCanvas `copy`绘制 → `convertToBlob(image/png)`。保留原Canvas colorSpace（sRGB或display-p3），不改变尺寸/插值/PNG格式，未生成Base64。Worker在完整PNG生成、关闭传入bitmap并释放surface后才回复Blob，host最终terminate短Worker；原finalize仍await完整Blob后再交付。Worker加载失败、messageerror、编码失败都结束候选并清理；异步bitmap晚于Worker错误才完成也会关闭，不给已终止Worker继续发图。

独立`__shinobuColdStartWorkerPngRgba`作为数据路径对照（须同时WorkerPng=true）：读取原Canvas拥有的ImageData，transfer底层ArrayBuffer，Worker按相同colorSpace构造ImageData/putImageData再编码。它避免JS clone，但主fixture仍需约45.6 MiB RGBA读回及Worker写Canvas；默认Bitmap路径避免这条完整JS数组往返。Bitmap可有原生GPU快照/读回成本，不能从API名称称其零拷贝。每次新Worker的加载也计入PNG时间，不通过预热隐藏冷成本。

CPU检查（2026-10-01 19:19）通过：原PNG+新Worker两套suite共6项；extension、benchmark、tests三个typecheck都通过。覆盖原flag默认/不可用回退、完整PNG前不释放surface、Bitmap或独立RGBA buffer转交、原尺寸、Worker终止与晚到snapshot清理。原生harness生成的页面与Worker JS也经CPU语法解析；这些均不代替真实alpha/颜色检查。

```powershell
npx vitest run tests/shared/browserPipelinePng.test.ts tests/shared/pngWorkerEncoder.test.ts --maxWorkers=1
npm run typecheck:extension
npm run typecheck:benchmark
npm run typecheck:tests

# Root串行运行，不加载模型、不需先build扩展。
$env:COLD_BUDGET_BROWSER = '同版本原生测试浏览器的绝对路径'
npx tsx benchmark/perf/src/check-worker-png-browser.ts --rounds=1
```

真实harness使用源码中的encoder/helper/Worker，在仅允许同源Worker的HTTP页面验证18组：GPU/CPU Canvas × sRGB的tiny/opaque/alpha/debug/no-text/主图12组，加display-p3的opaque/alpha/debug六组。每组分别比较Bitmap与RGBA Worker路径，检查PNG签名、完整PNG解码尺寸、逐字节decoded RGBA（alpha0..255）、P3结果在sRGB显示时的颜色、原Canvas未修改。若浏览器未实现某色彩空间会显式记录skip，不能将skip算通过。任一路径不一致均不能启用。

微基准可`--rounds=3`，可`--fixture=保存的最终译图路径`。计时包含每次Worker创建、像素快照/读取、转交、完整PNG、Worker清理及terminate；`png.worker`诊断mark仅在已有InitMark observer存在时记录mode/captureMs/drawMs/encodeMs/bytes。前台微基准仍不能替代真实offscreen首图；正式速度门须按同版本、同PNG完成+DOM decode+RAF终点全流程A/B。

root已在Chromium151运行18组原生质量门，无skip，两种Worker路径全部保持decoded RGBA、alpha、颜色和尺寸。完整记录`.tmp/cold-budget/worker-png-native-quality.json`。2921×4096输入fixture三种PNG都为7,915,903 bytes。此轮rounds=1，原native微基准结果如下，不能单凭它计入全程预算：

| 来源Canvas | 原同步PNG(ms) | Bitmap Worker(ms) | RGBA Worker(ms) |
| --- | --- | --- | --- |
| 默认GPU Canvas | 184.2 | 148.5 | 195.7 |
| willReadFrequently CPU Canvas | 139.9 | 183.3 | 210.8 |

默认GPU fixture的Bitmap capture约0、Worker draw0.3、encode140.2 ms；RGBA capture13.1、draw15.9、encode157.5 ms。native前台gate先读取原Canvas像素并运行多个小图，已预热GPU和Worker脚本缓存，这些细分不能代表全新offscreen最终Canvas的冷成本。CPU来源显示Worker路径也可能更慢，正式全流程A/B才决定是否启用。

## 低压缩 PNG 只读评估（未实现）

[Canvas编码选项规范](https://html.spec.whatwg.org/multipage/canvas.html#image-encode-options)仅提供type/quality，PNG没有可调压缩级别；[精确Chromium151 ImageEncoder源码](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/platform/image-encoders/image_encoder.cc)对PNG固定`SkPngRustEncoder::CompressionLevel::kLow`并忽略quality。因此给原生convertToBlob添加quality或compressionLevel不会降低PNG压缩。

本工作树已有fflate0.8.3（apps/web直接依赖，extension未声明）。它可做zlib level0/1，但不提供PNG封装；实验还需自行提供RGBA8/filter0、IHDR/sRGB/IDAT/IEND与CRC。无压缩stored-block PNG保持所有像素，但2921×4096 RGBA结果约47.87 MB，是当前7.99 MB译图的约6倍；另有全图RGBA读取、scanline数组、CRC遍历、Blob构造与更大的读取/下载成本。这个大小由像素/行和deflate block格式算出，不是性能测量。

减少deflate与PNG过滤工作可能帮助encode/解码，但它不能消除全部234 ms native decode Promise等待，也不能忽略更大数据的成本。Root已优先重复现有Bitmap Worker+adapter组合的完整PNG/DOM decode/RAF正常全流程，当前未编写额外PNG envelope、未增加依赖或变更产品压缩策略。

## 正常18样本：尾部收益和慢快轮范围

来源`.tmp/cold-budget/1790854168545-results.json`，同版本Chromium151，3轮×2组合×fresh/同Worker/保留缓存新进程，共18样本；全部最终RGBA仍为严格主图hash。下表core指`all-direct-latefonts-binary-prefetch-nofence-reuse-selectedfonts-deviceprobe-jsepjs-basic-async8-history4`，combo为其加adapteroverlap与workerpng。诊断QA的2682.6 ms不并入正式样本。

| fresh样本 | visible(ms) | order(ms) | mask(ms) | inpaint(ms) | typeset(ms) | 完整PNG(ms) | PNG之后显示(ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| core第1轮 | 3758.4 | 126.9 | 299.3 | 303.8 | 65.9 | 228.1 | 259.1 |
| combo第1轮 | 3505.2 | 135.4 | 293.0 | 295.7 | 41.7 | 234.7 | 263.3 |
| combo第2轮 | 3604.5 | 142.7 | 333.8 | 288.2 | 44.9 | 237.6 | 263.5 |
| core第2轮 | 2936.4 | 78.8 | 223.0 | 213.3 | 26.9 | 147.0 | 268.9 |
| core第3轮 | 3820.5 | 138.3 | 322.1 | 286.8 | 44.5 | 227.7 | 264.1 |
| combo第3轮 | 2708.4 | 78.1 | 193.0 | 232.1 | 26.5 | 151.0 | 282.1 |

fresh中位数core3758.4、combo3505.2 ms；combo仍比2845.5 ms目标多659.7 ms。保留缓存新进程中位数core2290.8、combo2266.9 ms，已达此前2332.7 ms缓存目标。这里不是workerpng单独A/B，不能把253.2 ms全归于PNG Worker。

combo慢两轮与快轮的PNG差约84–87 ms，typeset差约15–18 ms，而快轮显示反而多约19 ms；可见尾部只能解释全程约800 ms差异中的一部分。order、mask、OCR、bubble也同时变快；同Worker第二张仍出现类似CPU阶段慢快差，因此不能把整条波动称为字体首次加载或Worker首次加载。当前系统CPU占用记录也不能独立解释：快fresh轮约62.5%，慢两轮约47.1%/54%。这些只说明归因证据不足，不以环境负载替候选退化免责。

正常core的PNG228/147/228 ms与combo235/238/151 ms处于相似慢快执行区间，尚未证明PNG Worker独立稳定加速。现有runner已带关闭后台/遮挡节流的Chromium选项并将页面bringToFront；这些设置不能再计作新方案。

原生小候选仅作只读评估：提前启动短PNG Worker最多针对native质量门中约8–10 ms的加载/派发剩余，不能直接省去整个83 ms正常轮PNG差值。Worker内`bitmaprenderer.transferFromImageBitmap`有机会避免2D表面物化与绘制，但原生gate中2D draw仅0.3–0.4 ms；隐含GPU读回是否减少没有证据，不能预算几十毫秒。此项若实验需独立默认关闭开关，并重新过18组alpha/P3/PNG解码门，当前没有增加实现。

## 精确遮罩灰度分位值：256桶直方图

独立开关`__shinobuColdStartMaskHistogram`，默认false，仅需offscreen/pipelineHost上下文。`maskRefinement/algorithms.ts`的`detectOutlineWidth`原来收集ROI内mask==0的8bit灰度为number[]，排序后取`floor(length*0.25)`；候选按相同ROI和mask判断累加256桶，返回累计计数首次大于该rank的灰度值。Uint8输入保证离散值0..255，空集合仍立即返回0，原sort分支完整保留。

实际caller为`maskRefinement/index.ts`的逐区域细化；输入来自`readGrayImage`的Uint8Array。亮度阈值40、描边比例0.5、边界8邻域、四方向扫描次序、maxScanDist、输出描边宽度以及最后outlineDists中位数排序全部未改。没有降低图像分辨率或算法精度。

可复跑CPU门：

```powershell
npx tsx benchmark/perf/src/check-mask-histogram.ts
npm run typecheck:extension
npm run typecheck:benchmark
```

2026-10-01检查已通过：118组私有Q1选择器与独立sort参考一致，303组实际完整`detectOutlineWidth`开/关结果一致，gray/mask输入逐字节未改。样本覆盖空集合、全foreground、全部256灰度、0/255、分位rank边界/tie、100组确定性随机图与ROI裁剪/越界，以及预期宽度2的非零描边分支。extension/benchmark typecheck均通过。

| 仅Q1合成ROI | 原sort(ms) | 直方图(ms) |
| --- | --- | --- |
| 31×127 | 0.3438 | 0.0319 |
| 127×511 | 6.5508 | 0.2374 |
| 333×667 | 24.7680 | 0.7486 |

这些是CPU单次局部计时，不能作为真实mask或全程收益。最后outlineDists排序在32/256/1024样本的单次CPU检查约0.019/0.055/0.114 ms，当前不扩展该优化。完整RGBA和正常相邻A/B尚待root串行验证；在结果出来前不把直方图的合成节省计入2845.5 ms预算。

root随后在`.tmp/cold-budget/1790855631414`原生QA验证直方图候选完整主图RGBA与detector四份数据SHA全部相同。该诊断轮mask321.9 ms受probe扰动，不能用于估计直方图收益，正常相邻速度门仍另行执行。

## 默认关闭的遮罩分段诊断

`maskRefinement/index.ts`新增`__shinobuColdStartMaskProfile`，仅当host/offscreen同时开启该flag且已有`__shinobuColdStartInitMark`函数时计时。成功完成遮罩后只向observer提交一条`phase:'mask.refinement'`记录：开始/总耗时、原图与缩放尺寸、scaleFactor、区域数/分量数/处理区域数、debug与histogram/pixelFastPath状态及timings对象。不复制mask、图像或区域payload，不发HTTP，不逐区域调用observer；observer异常被隔离，不改变结果。

timings含`readBinaryMs/readGrayMs/prepareCcMs/ccMs/assignmentMs/regionsMs/finalDilateMs/toMaskCanvasMs`八个外层阶段。prepareCc包含区域缩放、ccInput副本及矩形outline准备；CC为connectedComponents本身。regions另附`refineMs/outlineMs/localDilateMs`三个累计子阶段，regionsMs还包含全图区域mask分配/组装、geometry与debug副本，子阶段不能再次加到总耗时。localDilate包括膨胀尺寸/ROI计算、提取、局部dilate及OR合入结果。

```powershell
npx tsx benchmark/perf/src/check-mask-profile.ts
```

tiny CPU门已通过8case，输入44×36（1584pixels），debug开关各覆盖flag关闭、有flag无observer、正常observer及抛错observer。flag关闭或无observer时performance.now调用数为0；正常/异常observer均只调用一次，完整RGBA与debug三层数据和源图/mask/regions不变，记录仅含标量metadata与标量timings。它使用数组Canvas，不验证浏览器插值，也不作为真实阶段耗时证据。此轮遵从root正在运行正常performance A/B的限制，未跑重CPU/typecheck/build或浏览器/GPU。

## 检测遮罩打包写入：保持阈值与Canvas路径

独立默认关闭开关`__shinobuColdStartMaskPacked`，仅需host/offscreen上下文。`detect/onnxDetect.ts`的两个私有函数`binaryMaskToCanvas`与`scaleMaskToOriginal`在RGBA数组byteOffset及length均4字节对齐时，用同buffer的Uint32Array view将每像素四次字节store改为一次word store。黑色opaque word由`Uint8Array.of(0,0,0,255)`的原生Uint32视图派生，白色为0xffffffff，不假定小端；不符合对齐条件保留旧字节循环。

二值mask仍按`mask[i]>0`，缩放后仍读取原red字节并按`>127`，alpha仍255；原Canvas尺寸、平滑resize/drawImage、getImageData、putImageData和原source不变。共享`buildMaskCanvasFromBinary`的两处检测结果返回均通过这两个函数，因此同一个开关覆盖实际模型两条路径；没有修改张量、threshold生成、模型输出、轮廓或区域后处理。

```powershell
npx tsx benchmark/perf/src/check-mask-packed.ts
npx tsx benchmark/perf/src/check-mask-profile.ts
npm run typecheck:extension
npm run typecheck:benchmark
```

CPU门45组通过，包括两个实际私有函数与组合caller逐字节对照、独立字节oracle、red0..255（含127/128）及随机RGB/alpha、mask0/1/2/255、RGBA offset0/1/2/3/4、最大33153pixels、不写prefix/suffix padding及源Canvas不变。DataView另模拟big/little两种端序验证opaque word推导；这不是在大端硬件运行生产实现。profile8组小门同时重跑通过。

extension typecheck通过。首次benchmark typecheck发现两个新CPU mock的PlatformProvider直接cast不足，已改unknown中转；重跑后这两个文件无错误，仍有另一agent新增`check-cold-image-blob-url.ts`三处类型错误，已交root处理。当前不声称本轮benchmark全局typecheck通过。

此候选仅理论减少数组索引/store次数，Uint32 view不复制像素，仍保留原完整Canvas往返。CPU门不计性能、不代替真实插值/完整detector SHA与最终RGBA；root原生质量和相邻两轮A/B才决定收益。

## 打包写入原生质量门与遮罩真实组成

root在`.tmp/cold-budget/1790857001697-results.json`两条真实完整流水线QA（仅writeupload开关不同）确认：含maskpack的组合两次最终RGBA、检测原始四份张量SHA、模型输入、OCR与provider均保持原样。两次主图仍为2921×4096与严格d3bd…hash。该报告为带InitMark/输入和输出验证的诊断轮，不能当作相邻正式速度实验。

对应两份原生`mask.refinement`记录：原/raw mask均2921×4096，scaleFactor=2/3，scaled1947×2731，9个区域、154个连通分量、9个处理区域。两条记录实际为histogram=false、pixelFastPath=true；本轮探针测的是原Q1 sort，直方图质量门在前述独立QA中已经通过。

| 遮罩阶段 | 较快诊断样本(ms) | 较慢诊断样本(ms) |
| --- | --- | --- |
| readBinary | 34.5 | 52.3 |
| readGray | 39.5 | 58.7 |
| scaleRegions/CC准备 | 1.6 | 1.6 |
| connectedComponents | 15.6 | 26.7 |
| 区域分配 | 3.4 | 2.0 |
| 所有区域处理合计 | 18.8 | 23.4 |
| 其中refine | 3.6 | 3.7 |
| 其中outline | 10.2 | 12.6 |
| 其中localDilate | 3.4 | 5.3 |
| 最终全图dilate | 9.1 | 22.5 |
| toMaskCanvas | 92.1 | 131.9 |
| mask总计 | 214.7 | 319.1 |

readBinary/readGray/toMaskCanvas三个读取与输出路径合计166.1/242.9 ms，约占总计77%/76%；这些路径包含Canvas缩放/读回和像素循环，当前探针没有进一步将native Canvas与JS循环拆开，不能把整个数值称为GPU读回或纯CPU代价。outline也包含完整向外扫描，直方图收益必定小于其10–13 ms整个阶段，不再以合成大ROI排序的24 ms数值外推本fixture。

`toMaskCanvas`静态链为scaled二值mask→scaledRGBA/ImageData→put→原尺寸Canvas平滑drawImage→全图getImageData→red>127二值化/alpha255→put。两个写入循环在当前pixelFastPath=true组合中已经是Uint32 store，剩余92–132 ms不能重复归功于maskpack；maskpack主要针对detector自己的两条loop。

仅保留后续只读备选：让toMaskCanvas已经拥有的、阈值之后完全opaque的ImageData由内部WeakMap短暂复用给inpaint同尺寸readMaskBinary，可减少另一轮全图getImageData和RGBA临时分配。512模型输入仍走现有Canvas平滑缩放，完整refinedMaskCanvas端点仍生成，阈值/尺寸/数据值均须原生验证一致。此方案会延长约45.6 MiB数组寿命至inpaint消费，需要限定Canvas未修改、尺寸一致并及时释放；它最多针对下一阶段readMask的一部分，不能省去整个toMaskCanvas。当前未实现，先等root普通三轮结果，达到目标则不追加优化。

## 新普通三轮与两个独立候选

普通报告`.tmp/cold-budget/1790857271448-results.json`，完整noWrite组合fresh3152.896/3285.333/2481.144 ms，中位3152.896，比2845.5 ms目标仍多307.396 ms；withwrite中位3205.325 ms，没有证明write稳定收益。保留缓存新进程中位约2159/2110 ms已达缓存目标。这些普通样本与先前3479/2419 ms QA分开记录，速度结论不依赖验证轮。

### NativeThreshold：仅替换最后一次阈值往返

startup提供`pipeline/image.ts`的`tryNativeOpaqueMaskThreshold(sourceCanvas,platform):PipelineCanvas|null`，共享默认关闭`__shinobuColdStartMaskNativeThreshold`；我在`algorithms.ts toMaskCanvas`中，仅于原有平滑resize已生成原尺寸8bit灰阶Canvas后调用helper。成功返回native新Canvas；失败仍走原getImageData、red>127、alpha255、putImageData完整路径。scaled二值RGBA store、尺寸、灰阶量化和native插值均不变。

helper在已有灰阶Canvas上按1:1 `contrast(100000%)`，前提source与target明确为sRGB/unorm8，filter赋值与绘制成功；未知属性或错误都返回null并清理失败target，source不被写入。它针对最后整图get+JS阈值+put，不能把此前source scaled→original native resize也记成省略。root已独立通过共享helper14组原生门，toMaskCanvas整合与主流程仍需随后完整质量/速度门。

### SourcePreRead：真实检测提交后局部预读

独立默认关闭`__shinobuColdStartSourcePreRead`，offscreen/host启用。在`detect/index.ts`及`onnxDetect.ts`只透传最后optional callback到既有`modelRuntime.runImage(...,onSubmitted)`；已有bridge在Comlink真实post成功后才执行callback，bitmap已提交给Worker再开始CPU准备，没有另加调度器/Worker。

orchestrator单次局部准备`prepareTextMaskGray`与`prepareInpaintSource`，均调用原readGrayImage/readDirectCanvasImageData或原readCanvasRgba。mask消费时检查source身份、scaled尺寸与pixel length；inpaint检查source、原尺寸、RGBA length、DirectPixels模式与ImageData别名，不符则原路径。预读失败保持undefined，后续原mask/inpaint阶段仍自行报错。stopAfterOrder和precomputedDetection均不创建提前读路径；数据消费后清除orchestrator局部引用，没有全局45.6MiB mask缓存。

灰度在主图占5,317,257 bytes（约5.1MiB），原图仍为现有必需47,857,664 bytes，只是提前持有，composition仅修改getImageData拥有的副本。静态可隐藏上界约readGray39–59 ms加readOriginal先前约50–60 ms，共约90–120 ms；真实GPU提交后CPU工作可能争用Canvas/GPU资源，不能把上界直接记入307ms缺口。InitMark存在时单条`source.preread`记录gray/original duration及准备成功状态，正常无observer不加时钟。

原生风险须独立验证：早读originalCanvas.getImageData可能改变其后端状态，后续512原生重采样可能因此变化。数学上同一RGBA副本不足以证明预读不影响输出；若失败可仅考虑灰度预计算，或将原图预读移至512预处理完成后与inpaint model.run重叠，但两者当前未替换实现。

```powershell
# 已执行：tiny CPU gate（26 prepared + 8 native integration/fallback）
npx tsx benchmark/perf/src/check-mask-preread.ts
# 已执行：仅解析生成JS，不开浏览器
npx tsx benchmark/perf/src/check-source-preread-browser.ts --syntax-only
# Root串行执行真实浏览器质量门，不加载真实模型
$env:COLD_BUDGET_BROWSER = '同版本原生测试浏览器的绝对路径'
npx tsx benchmark/perf/src/check-source-preread-browser.ts --out=.tmp/cold-budget/source-preread-native-quality.json
```

CPU门覆盖strict flag、scope构建/post之前不读、callback最多一次、stop/precomputed/cancel守卫、提前读取失败与observer异常、source/dims/length/DirectPixels不符回退、debug层一致、模型feeds一致、original/mask未改。有效准备数据消费实际少一次getImageData，错误准备与baseline读取次数相同。Native整合模拟unsupported/属性未知/draw失败均保留原CPU阈值；成功分支不get/put原尺寸gray或target。最大2244pixels，仅数组Canvas，不作为滤波或真实插值质量证据。

原生harness从源码取得实际preprocess/decode/resize/compose与灰度helper，GPU/CPU source context×DirectPixels开关×opaque/alpha0..255/2921×4096主图×gray-only/gray-and-original共24组。每组baseline与candidate为两幅独立原图Canvas，baseline在自身真实inpaint操作前不提前读取原context；逐位比较512×512 float32 image/mask feeds、gray、最终compose RGBA和源Canvas未改，模型输出使用同一确定性Float32假tensor。root已在`.tmp/cold-budget/source-preread-native-quality.json`完成24/24原生门，无失败；它不能替代真正扩展所有模型/raw detector SHA与最终严格hash的Root全流程门。

最新普通27样本`.tmp/cold-budget/1790859883194-results.json`中，base fresh中位3174.47 ms、threshold3356.40 ms、threshold+preread3284.74 ms；后者cached中位2147.56 ms。质量通过仍未证明这两项正常冷启动收益，因此不能从90–120 ms预读理论上界或Canvas往返静态数量扣减预算。当前base相对2845.5 ms目标仍缺328.97 ms。

## PNG无行过滤与原生deflate：独立实验，未接生产

先核对实际原图输入PNG：2921×4096、8bit RGBA（IHDR colorType6）、非interlace；4096行全部filter2/Up。1928个IDAT，compressed7892722 bytes，inflated47861760 bytes，文件7915903 bytes，仅IHDR/IDAT/IEND三类chunk。alpha全部255。解出**输入fixture**的RGBA SHA为041d64a8…，与最终译图d3bd…hash分别记录，不能互换。探针`.tmp/cold-budget/png-none-cpu-probe.json`保留完整结果。

这与151源码吻合：Blink PNG编码选kLow，其DEPS固定的Skia0208108c…映射为Level1WithUpFilter，Rust明确`set_deflate_compression(Level(1))`和`Filter::Up`。当前PNG没有复杂的自适应Paeth选择成本。[Blink编码入口](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/platform/image-encoders/image_encoder.cc)、[固定Skia版本](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/DEPS)、[Skia映射](https://raw.githubusercontent.com/google/skia/0208108c7aed5f4e0faa525cbba52c238005a1ef/src/encode/SkPngRustEncoderImpl.cpp)、[Rust过滤和压缩级](https://raw.githubusercontent.com/google/skia/0208108c7aed5f4e0faa525cbba52c238005a1ef/rust/png/FFI.rs)。

CompressionStream的deflate是PNG所需的zlib包装格式，151实现固定level6，标准接口无compression level参数。它是在浏览器线程中调用zlib，Promise/stream接口不意味着底层压缩必定卸到另一线程；独立候选在短Worker中运行。[Compression标准](https://compression.spec.whatwg.org/)、[151固定级别](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/modules/compression/compression_stream.cc)、[151 zlib调用](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/modules/compression/deflate_transformer.cc)。

仅benchmark的`png-none-experiment.ts`实现8bit sRGB/非interlace、filter0、原生完整deflate stream、IHDR/sRGB/IDAT/IEND与标准CRC32。RGB仅在实测每个alpha=255时采用，否则RGBA；P3/unknown/非unorm8 Canvas在harness进入此函数前回原生PNG。不实现PNG通用库，不改尺寸、插值、格式或色彩，完整stream trailer+CRC+PNG Blob完成后才交付。

`check-png-none-cpu.ts`12组synthetic门通过：1×1/17×13/256×3、alpha0..255/opaque、RGB优先开关、非零byteOffset、padding/source不变、PNG inflate逐字节回读、全部CRC与node:zlib.crc32和123456789标准向量对照。另原图4个编码组合回读RGBA一致。Node一次预估如下，不是Chrome性能结论：

| filter-none | 原生Node zlib级别 | pack含opacity(ms) | deflate(ms) | PNG bytes | 相对原PNG |
| --- | --- | --- | --- | --- | --- |
| RGBA | 1 | 8.0 | 112.9 | 6410791 | 81.0% |
| RGBA | 6 | 8.0 | 469.2 | 5509173 | 69.6% |
| RGB | 1 | 71.3 | 114.7 | 7354878 | 92.9% |
| RGB | 6 | 71.3 | 369.3 | 6540822 | 82.6% |

文件体积没有之前无压缩47MiB的6倍问题，RGBA甚至比RGB更容易被此类deflate压缩；但CS只能level6，CPU估计已经高于现有nativeWorker约150–255 ms编码。不能靠filter-none直接外推image.decode约230–250 ms全部消失，Up是简单加法、原生decode也含inflate/CRC/颜色与alpha处理/调度；Node JS Up还原56.7 ms也不等于原生浏览器unfilter成本。暂不建议生产接入，先完成独立原生encode+decode总计反证。

## 原生PNG opaque导出目标：优先原生门

同一个独立harness加入native-rgb-bitmap和native-rgb-rgba，均保持151原生kLow/Up/level1编码；仅当已读取实际RGBA中每个alpha255、sRGB/unorm8明确时，新建**导出Worker目标**alpha:false，以促使PNG写colorType2。源Canvas/排版Canvas的alpha和文字AA不动。非opaque/P3/未知格式/opaque目标属性不符均调用原encodeWorkerPng完整旧路径。

bitmap模式完整计入Worker内RGBA scratch draw/getImageData+opacity scan+另一opaque目标draw；rgba模式使用现有helper真实getImageData与transfer输入，在Worker扫描其alpha后put到opaque导出目标。不能以预先知道fixture opaque省略12MP scan/readback。对照保留原native bitmap及原native RGBA两种输入，明确看到读取开销。目标RGB数据每行3字节而原RGBA4字节，可减少25%解压后行字节，实际encode/decode净收益仍由相同原生harness决定；不宣称总耗时同样减少25%。

8组tiny Worker API mock门通过（两个模式×opaque/nonopaque/P3/unknown），验证实际harness Worker函数的alpha守卫、fallback、恰一次导出和输入/输出像素未改。它是分支门，PNG RGB header和原生renderer语义必须由root真实浏览器逐字节验证。默认18组原生矩阵包括sRGB GPU/CPU×tiny/opaque/alpha/debug/noText/fixture及P3 GPU/CPU×opaque/alpha/debug，无skip策略；opaque候选header必须type2，fallback必须与原baseline colorType相同。

```powershell
# 已执行：CPU PNG格式/CRC/oracle + 原fixture过滤与体积预估
npx tsx benchmark/perf/src/check-png-none-cpu.ts --out=.tmp/cold-budget/png-none-cpu-probe.json
# 已执行：Worker alpha路径tiny API门和两种JS生成语法门，无浏览器
npx tsx benchmark/perf/src/check-png-none-browser.ts --cpu-gate
npx tsx benchmark/perf/src/check-png-none-browser.ts --syntax-only --fixture-only --opaque-only --rounds=1
npx tsx benchmark/perf/src/check-png-none-browser.ts --syntax-only --rounds=3
# Root优先原fixture，真实同版本浏览器，测完整PNG Blob返回+解码+RAF
npx tsx benchmark/perf/src/check-png-none-browser.ts --fixture-only --opaque-only --rounds=1 --out=.tmp/cold-budget/png-opaque-fixture-native.json
# Root随后18组质量/三轮；不加opaque-only也纳入CS filter-none反证
npx tsx benchmark/perf/src/check-png-none-browser.ts --opaque-only --rounds=3 --out=.tmp/cold-budget/png-opaque-native-quality.json
```

harness复用实际pngWorkerEncoder快照/传递/清理及实际pngEncodeWorker原生fallback，test-only Worker分支由localhost server提供，不触碰生产Worker/build/dist/runner/协议。时钟包含每次短Worker启动、capture/transfer、read/scan/pack、原生encode或CS完整压缩、CRC/Blob生成与Worker交付、内容img BlobURL、唯一decode和RAF；质量读回与PNG filter/header统计在时钟后。模式顺序轮转，original-png模式仅当作已存在原文件的decode-only控制，明确encode=0不当作重新导出的全程收益。此处为foreground原生微实验，仍需要真实offscreen完整流程A/B后才能计入预算。

### Opaque原生门：实际RGB输出，净收益为负

Root在`.tmp/cold-budget/png-opaque-fixture-native.json`完成Chrome151主图两种源context、各一轮。所有模式decoded RGBA与源Canvas逐字节相同；opaque两候选确实写出colorType2，行数据47861760→35897344 bytes、文件7915903→7782614 bytes（仅减1.68%）。实际收益如下，表中total包含完整Worker与decode/RAF；单轮微实验不当作正式冷启动中位数：

| 模式 | GPU源编码(ms) | GPU源decode(ms) | GPU源total(ms) | CPU源编码(ms) | CPU源decode(ms) | CPU源total(ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 原native bitmap | 157.7 | 84.8 | 250.6 | 188.1 | 96.9 | 290.3 |
| 原native RGBA | 239.9 | 94.7 | 345.4 | 199.2 | 94.6 | 302.4 |
| nativeRGB bitmap | 274.5 | 97.3 | 379.1 | 247.0 | 92.6 | 345.3 |
| nativeRGB RGBA | 230.0 | 94.1 | 330.3 | 230.1 | 90.4 | 327.0 |
| 已存在original PNG（无导出） | 0.2 | 66.9 | 67.3 | 0.1 | 70.4 | 70.9 |

bitmap候选额外read42.0/85.2 ms及alpha scan6.7/6.6 ms；native编码本身152.1/180.4→213.3/140.9 ms也有变异。RGB没有稳定减少decode，读取与重建目标将全程推高；RGBA输入相对当前原native bitmap也更慢。因此不接生产、不扩18组质量门、不从25%inflated字节减少推算25%decode或全程加速。filter-none+CS原生门未运行，也未接生产。

## 全流程显示尾部与独立解码差异：调用链核对

真实SC链：host完整PNG Blob→broker透传result-meta/complete→localPipelineClient.finish直接保留Blob→execution result→photoStateProjection.createObjectURL一次→renderScreenshotResultUi仅当src不同时赋值。没有这里的Canvas读回、另一轮PNG导出、Base64转换或Image对象中转。旧URL仅在替换后/关闭结果时revoke；首图无旧译图URL，当前结果URL不被提前撤销。此前关闭offscreen后内容URL仍fetch/解码通过也排除了host URL生命周期故障。

产品显示不调用decode；验收runner MutationObserver发现首个translated img.src后调用一次decode，再记录一个RAF。SHA验证的第二次decode在visibleResult和displayDiagnostics已经取得之后。因此哈希门不延长当前displayTail，重复render的src guard也避免重新启动图片请求。photoStateProjection在结果投影前finishJank，故displayTail包括URL/投影/渲染和native decode/RAF；该定义没有等待CSS transition结束。

`.tmp/cold-budget/1790858817153-results.json`两份真实QA显示src→load均12.8 ms、decode Promise250.4/229.5 ms、decode→RAF1.2/5.2 ms，displayTail277.5/259.1 ms。finish日志→src只多约25 ms，主要差异仍在decode Promise内部。Jank monitor的stop早于结果URL和src，所以本报告尾部空longTasks不证明解码期间没有main-thread争用。

独立门不是同一负载：使用输入PNG，而完整流程使用已擦字PNG（约7.99 MB）；独立page简单且已准备canonical native PNG，IMG maxWidth300，真实overlay约720宽、同一IMG先显示原图再替换译图，页面中仍有源图和进度UI。它没有证明full native decode实际CPU只需70–100 ms，更不能将真实230–250 ms全部视作PNG unfilter。151 ImageLoader会将整个image矩形、FilterQuality kNone作为RequestDecode交给合成器，随后ImageController有队列与external raster dependency；native层可能与首次缩放paint请求争用，即使JS层只一次decode。[151 ImageLoader](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/core/loader/image_loader.cc)、[151 ImageController](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/cc/tiles/image_controller.cc)、[151 GPU解码缓存](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/cc/tiles/gpu_image_decode_cache.cc)。

少量观察建议（未自行加runner/运行）：现有display probe附加transitionrun/start/end/cancel的propertyName和epoch，decode至RAF期间单独LongTask/LoAF observer，限制记录数且不增加decode/readback；一次诊断trace增加cc/benchmark/disabled-by-default-cc.debug，比较QueueImageDecode、ProcessNextImageDecodeOnWorkerThread、DecodeImage执行区间与paint/raster请求。`kSendExplicitDecodeRequestsImmediately`在151默认开，因此不能无证据称为等下一commit固定一帧。[151 compositor功能默认值](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/cc/base/features.cc)。

### DisplayInstant：独立默认关闭的最小CSS实验

源码明确线索为styles.ts中IMG `transition: opacity .16s, filter .16s`，running-original有saturate(.96)/brightness(.99)，完成后同一元素换src并退出filter。160 ms接近真实与独立尾部差额，但decode标准不要求等待CSS transition；这仅是可验证的raster/合成争用假设，未确认为原因。

root授权默认关闭`__shinobuColdStartResultDisplayInstant`。仅在`createScreenshotResultUi`创建IMG时，strict flag===true设inline transition='none'，覆盖该结果IMG的过渡；两个caller为context-image与截图。正常路径不写inline，render/src/status/尺寸及原PNG/排版Canvas完全不动；后续没有覆盖IMG transition的调用，不引入forceLayout、恢复定时器或新缓存。最终computed transition配置按实验意图为none，最终filter仍应none/opacity1、尺寸与result src不变，由root原生QA确认。

```powershell
# 已执行：实际constructor/render/setRectStyle抽取的小DOM API门
npx tsx benchmark/perf/src/check-result-display-instant.ts
```

6种flag（undefined/false/true/string/1/null）×5状态的小门通过；原图→译图→重复render→切原图→再次译图中src仅4次写，dataset/host720×1009 rect/其他IMG style/class/alt/draggable/close元素相同。只true改变transition。门不模拟CSS/nativepaint、没有browser/GPU/heavy CPU/typecheck；root runner在content prefix启用displayinstant，并保持完整PNG交付、同一decode与RAF终点。

### DisplayInstant真实QA：没有明确尾部收益，排除于最终组合

Root报告`.tmp/cold-budget/1790863277823-results.json`两行仅差displayinstant。我只核对其`displayDiagnostics`与`blobLifetime`字段，结果如下；这两行是带验证的QA，不能代替普通计时中位数：

| 同一完整组合 | src→load(ms) | decode Promise(ms) | decode→RAF(ms) | displayTail(ms) | visibleResult(ms) |
| --- | --- | --- | --- | --- | --- |
| 原过渡 | 7.7 | 157.0 | 3.2 | 174.19 | 2529.79 |
| DisplayInstant | 7.7 | 156.3 | 2.9 | 173.41 | 2548.81 |

两边在hash检查前均只有一次decode。关闭过渡仅使tail少约0.78 ms，完整visible反而多约19.02 ms，没有明显显示收益，也不能把先前真实流程与独立页面的解码差额归因于160 ms transition。因此保持默认关闭，不扩普通轮次，不纳最终候选。

`finalComputedStyle`字段的采样时点是首个decoded RAF，不代表CSS过渡已经settled：原过渡在该时点仍为filter `saturate(0.962601) brightness(0.99065)`、transitionDuration `0.16s, 0.16s`；DisplayInstant为filter `none`、transitionDuration `0s`。两边opacity都是1、objectFit都是fill。首帧computed filter并不完全一致；改变的是临时过渡呈现，不能称为首帧样式逐项不变。导出PNG与其decoded RGBA仍严格相同。

两边关闭唯一offscreen后，hostCount均1→0，同一内容BlobURL仍能fetch且完整解码。关闭前后主图2921×4096、PNG7988558 bytes、PNG SHA `03add1fb9c9f71093afee8d6133def7d3ee3a84267e97da65df5fe698eac1c98`、RGBA SHA `d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97`均一致。Root同时报告两行raw四SHA/OCR一致、GPUerrors0、device未lost，峰值约1.144 GB相同。

## 最终组合收敛与第二张图质量门

Root首次三轮普通DownloadBlob+lateinpaint完整组合fresh中位2523.6 ms，范围2259.7–2748.4 ms；cached中位2130.0 ms，范围2017.4–2261.1 ms，完整质量门通过。这一组fresh低于固定2845.5 ms预算，但**随后普通确认三轮旧候选约2612/3370/3341 ms、中位3341 ms，仍比固定预算多约495.5 ms**。该次确认不能宣称旧组合稳定达到减半，不能只采用首组快样本。两个结果都保留；DisplayInstant两行QA也不替代普通速度结论。加入GPU阈值目标后的新组合证据见后续章节。

第二张图原baseline与selected组合的质量报告`.tmp/cold-budget/1790863172428-results.json`在当前Chrome151均为1487×2048，PNG3536271 bytes，PNG SHA `88eab557ea563fcce9b9f045025dbcb6e99d5dc739a894346b4a4597f6e2e169`，RGBA SHA `06007f59966f605e51fc0ceab3f8aa13b5b5282218b77be762a6c9abdf1bfda0`。两行host1→0后BlobURL可读、PNG与RGBA不变，Root报告四个detector raw SHA与OCR一致。旧Chrome145的第二图hash不作为151的验收基准；质量比较使用同一浏览器版本的baseline与candidate。

## NativeThreshold GPU目标：独立默认关闭的小候选

Root授权`__shinobuColdStartMaskNativeThresholdGpu`，仅在已有`__shinobuColdStartMaskNativeThreshold===true`时生效。源码只修改`pipeline/image.ts tryNativeOpaqueMaskThreshold`中新建target的`willReadFrequently`：新flag严格等于true时由true改为false，其他值仍true。原sRGB/unorm8检查、已量化的opaque灰阶source、`contrast(100000%)`、关闭平滑、1:1 copy、source不写、unsupported/error返回null与失败target释放均保留，不修改模型或mask refinement caller。

动机是避免原native策略将过滤目标强制请求为CPU Canvas，可能让整图filter raster与后续Canvas复制仍发生CPU工作。`willReadFrequently:false`是后端提示，不保证实际GPU加速；成功draw也可能只是提交待执行的工作。下游mask灰度缩放与getImageData仍需完成，不能把异步draw耗时降低直接算作省去整图处理，收益只按普通完整PNG+decode+RAF终点计算。Root现已通过28个原生质量case与2个P3回退case（`.tmp/cold-budget/native-mask-threshold-gpu-quality.json`，Chrome151，nativeSuccesses28），两张完整模型流程QA与普通三轮结果见后续；最终五轮独立确认仍由Root执行。

`check-native-mask-threshold-cpu.ts`64组tiny API门已通过：main与GPU flag的undefined/false/true/string/1/null组合、全256整数灰阶、alpha255、source不改、恰一次filter draw且restore状态、observer抛错不影响输出，以及source/target属性未知/P3/float16/context缺失/filter不支持或拒绝/draw失败/属性抛错的旧路径回退和失败target清理。它证明分支与调用约束，不能证明真实浏览器filter精确性。

原生`check-native-mask-threshold-browser.ts`扩为28个质量case与2个P3回退case：CPU/GPU source settings×CPU/GPU target策略，全256灰阶和6组随机二值mask平滑resize（含730×1024→2921×4096），逐字节比较实际detector scale输出、每像素alpha255和source未改。baseline与native使用独立source Canvas，native source在draw前不被getImageData读取；oracle来自上传的ImageData或独立baseline。target getContextAttributes必须证明请求策略、sRGB与unorm8实际执行，不能静默fallback后称native通过。Root原生28+2已通过，同一source后端的CPU阈值和native CPU/GPU目标结果严格相同；该门不证明切换source后端时的resize一致。

```powershell
# 已执行，无浏览器
npx tsx benchmark/perf/src/check-native-mask-threshold-cpu.ts
npx tsx benchmark/perf/src/check-native-mask-threshold-browser.ts --syntax-only
# Root使用同版本151原生浏览器串行执行
npx tsx benchmark/perf/src/check-native-mask-threshold-browser.ts --out=.tmp/cold-budget/native-mask-threshold-gpu-quality.json
```

### 二值小源改CPU：跨source结果已有翻转反例，暂不接产品

Root进一步提出只将`toMaskCanvas`低分辨率二值源首次context改为`willReadFrequently:true`，避免putImageData后GPU upload再由CPU目标drawImage读取。当前函数确实是默认源context、二值opaque RGBA putImageData、CPU目标context、smooth draw放大后阈值；detector.scaleMaskToOriginal也使用同一CPU目标与smooth draw结构。未修改产品source设置。

上述28组原生报告的随机source在每个相同尺寸case使用固定seed、相同0/255像素。跨source设置比较最终SHA后发现，6组resize中4组不同，而且CPU/GPU native阈值目标两策略均复现：

| resize | GPU source最终RGBA SHA前缀 | CPU source最终RGBA SHA前缀 | 跨source一致 |
| --- | --- | --- | --- |
| 1×1→1×1 | ad95131b | ad95131b | 是 |
| 2×2→17×23 | 63af6ac6 | 63af6ac6 | 是 |
| 5×7→47×61 | cc158479 | af435659 | 否 |
| 73×41→299×179 | 0cf08f26 | 0b4b4638 | 否 |
| 129×181→773×1107 | fe330b7f | 4333d56d | 否 |
| 730×1024→2921×4096 | 0bbd5103 | 2c06eba9 | 否 |

256整数灰阶直接阈值在两source设置相同，各source内native阈值仍与原CPU阈值相同。由于最终结果是每像素严格0/255、alpha255的二值灰度，跨source SHA不同意味着平滑resize的量化差异确实跨过了127/128阈值，不能用“源只有0/255”保证输出不变。这与撤回的SourceCanvasCpu广泛改变原图context实验属于相同后端风险，但本结论直接来自二值遮罩而非彩色原图。

主refine实际1947×2731→2921×4096约1.5倍，不等于上表4倍主尺寸案例；尚不能宣称这张fixture的实际refined mask一定改变。但通用source CPU设置已有明确严格质量反例，因此当前不建议接产品，也不把潜在upload减少计入预算。若Root仍需要定量实际caller，可独立抽取原`toMaskCanvas`，仅测试platform创建的第一个源Canvas预建CPU context，保持真实wordstore/resize/native阈值；比较独立baseline的最终RGBA、原始放大灰阶127/128统计与二值翻转数。该实际caller门尚未实现/运行，不引入新的Canvas抽象或自制插值。

SourceCanvasCpu的独立真实PNG加载/复制/后续重采样门`.tmp/cold-budget/source-canvas-cpu-native.json`也明确失败18/28，包含opaque图。例：sRGB opaque2053×257源缩到panel1800×225时有1177676个RGBA byte不同，首byte baseline4/candidate3；其1:1 source复制仍相同。该产品guard已由负责agent撤回。它与二值4/6反例分别保留，不能用其中一项测试的within-backend通过替另一项跨backend证明；后续不再改变源Canvas CPU/GPU选择。

## GPU阈值组合：两张完整QA与普通三轮

### 质量与实际执行门

主图QA `.tmp/cold-budget/1790866046598-results.json`比较旧chosen、chosen+readparallel、chosen+readparallel+threshold+thresholdgpu。三行2921×4096最终RGBA均为`d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97`；detector input及blk/seg/det三输出四个SHA完全相同，17个OCR region的box/direction/text/confidence也与chosen完全相同。这里的四个SHA是input加三份raw output，不应称为四份raw output。

GPU组合的两个实际consumer均记录`mask.native-threshold status=success`：detector原尺寸阈值约0.4 ms、toMaskCanvas原尺寸阈值约2.7 ms，没有unsupported/failed记录。runner同时给offscreen及其chunks注入严格GPU flag，原生门还要求target getContextAttributes中的willReadFrequently=false、sRGB/unorm8实际生效。trace本身只证明native分支成功，不直接证明所有绘制物理执行在GPU上；实际加速仍按完整结果时钟确认。

第二图QA `.tmp/cold-budget/1790867139694-results.json`及汇总`readparallel-thresholdgpu-secondary-quality.json`比较当前151原baseline与GPU组合；四个detector SHA、OCR文本/confidence/region/input dimensions/providers均与baseline及旧chosen相同。最终1487×2048 RGBA为`06007f59966f605e51fc0ceab3f8aa13b5b5282218b77be762a6c9abdf1bfda0`，完整PNG3536271 bytes、SHA `88eab557ea563fcce9b9f045025dbcb6e99d5dc739a894346b4a4597f6e2e169`。两个native consumer实际success约0.8/0.2 ms。关闭唯一宿主后hostCount1→0，同一内容BlobURL仍可fetch、完整PNG与decoded RGBA/尺寸不变。

因此本候选的保留门是：64组严格flag/回退小API检查、28个原生同source后端RGBA逐字节case及2个P3回退、两张同151真实扩展的input+raw output SHA/OCR/final RGBA，以及完整PNG交付/解码和宿主关闭后的下载能力。不能只通过低层filter灰阶门就略去完整模型与两张图；质量QA的单轮耗时也不当作普通性能结论。

### 普通三轮端到端与波动

普通报告`.tmp/cold-budget/1790866767884-results.json`，同版本独占浏览器/GPU，每个fresh为new-profile，retained-cache-new-process单列；时钟始终包含完整PNG交付、内容IMG decode和一个RAF。Root核对三组全部最终RGBA/OCR一致，没有通过延迟导出或缩短终点获益。

| 完整组合 | fresh三轮(ms) | fresh中位(ms) | retained-cache-new-process中位(ms) |
| --- | --- | --- | --- |
| 旧chosen（DownloadBlob+lateinpaint） | 2523.8 / 3259.0 / 2829.7 | 2829.7 | 2111.5 |
| chosen+readparallel | 3363.0 / 3193.2 / 2368.1 | 3193.2 | 1969.3 |
| chosen+readparallel+threshold+thresholdgpu | 2311.7 / 3156.3 / 2392.5 | 2392.5 | 2042.6 |

GPU组合在这组三轮fresh中位比同组chosen低约437.3 ms（15.5%），比固定2845.5 ms预算低约453.0 ms。但其最慢fresh仍3156.3 ms、范围约2311.7–3156.3 ms；因此保留全部样本与波动，不称每次冷启动都低于预算。readparallel单独fresh没有稳定收益，cached结果与fresh也不能混合成一个中位数。Root下一步原baseline对GPU组合五轮普通确认，尚未用这组三轮替代最终确认。

### 工作移动与剩余尾部

主图QA中readparallel→GPU组合的mask_refine274.6→149.9 ms，但inpaint205.4→279.3 ms，其中resize48.1→91.7、readMask31.9→35.2 ms。原生GPU draw快速返回可能将同步/raster等待移入后续阶段。普通三轮按各阶段独立中位，chosen→GPU组合mask_refine241.3→142.5 ms，同时bubble193.7→252.6、inpaint215.6→263.4 ms；这些阶段中位数不能相加当成全程中位数，也不能把约98.8 ms mask差额全部记作删除。整体收益只依据上述完整visibleResult比较。

GPU组合主图QA的完整PNG Worker155.3 ms，内含encode150.5 ms、snapshot0.2 ms、draw0.3 ms；SC result-meta从host发出到content收到约4.1 ms。内容IMG只decode一次，Promise约161.1 ms，随后RAF约3.4 ms。交付路径没有再做base64、第二轮PNG导出或额外图片解码，现有JS转发/快照不是剩余百毫秒级主因。更换原生接收方式或局部读回虽可作为以后研究方向，但当前没有通过同质量门且明确减少完整端点耗时的新证据；本轮不再增加benchmark或产品改动，优先完成五轮确认。


## 主控最终确认

最后五轮普通对照已完成：新 profile 中位数 **2431.2 ms**（2405.7–2783.9），缓存重启 **2042.7 ms**（1830.3–2142.5）；两个状态各五轮均低于原定2845.5/2332.7 ms预算。第二图及主图原流程的四组原始检测SHA、OCR、最终RGBA校验通过。详见 [最终报告](cold-start-budget-final-2026-10-01.md)，其中区分固定预算、同期对照、工作转移和先前长尾。所有实验开关默认关闭。
