# 阅读顺序面板准备：CPU分项与真实页面诊断

## 当前实现与调用

`packages/image-pipeline/src/pipeline/readingOrder.ts`的`detectPanels`固定maxSide=1800、灰度系数0.299/0.587/0.114、7×7 separable Gaussian `[1,6,15,20,15,6,1]/64`、阈值200、白色border10后invert、8邻接BFS。按原row-major scan返回全部组件rect+area，再应用原minArea/包含关系/coverage/maxCount规则。

原`sortRegionsForRender`仅在regions>1且未传preparedPanels时执行检测；`prepareReadingPanels`是同一检测的提前入口，原异常返回null表示simple-sort fallback。当前full组合已有PanelOverlap：orchestrator在detector Session的等待窗口同步调用prepareReadingPanels，之后order阶段使用同结果，不再次读Canvas。这一提前收益已在组合baseline内。

两个既有connectedComponents helper不能直接替换：detect版本预先过滤count、box尺寸与density；maskRefinement版本过滤area≤9，并保留pixels/center。面板版本只需要全部组件rect/area，组件顺序来自最早的row-major前景像素。改变邻接或提前过滤都需要证明原规则一致，不能因函数同名视为可直接复用。

## 一次轻量CPU微测

方法：`node benchmark/perf/src/profile-reading-panels-cpu.mjs`。从当前真实readingOrder源码提取私有函数，不加生产export。使用既有2921×4096 PNG fixture，按原公式缩为1284×1800，保留threshold/border/maxSide，已有PixelFastPath=true。

本机node-canvas没有canvas.node二进制，初次启动即失败；未安装或重编译。随后仅用已安装sharp/libvips的Lanczos3取得RGBA供CPU函数分析。**这些缩放像素和177.4ms decode+resize不是Chromium Canvas输出或性能证据**。本次完整Node执行1.04s，无浏览器/GPU/build。原始记录在`.tmp/cold-budget/reading-panels-cpu-2026-10-01.json`，运行时源码SHA=`bdb20c47a6bc86e0be1a380d7e645e1f7fcff9a64c8199f7f583a59c7973496e`，早于下节observer的源码插入，算法函数未改。

| 算法项（ms） | 第一次 | 同进程第二次 |
|---|---:|---:|
| gray | 5.83 | 5.05 |
| Gaussian（已有fast path） | 30.57 | 31.92 |
| threshold | 3.20 | 2.37 |
| border+invert | 6.23 | 4.48 |
| 8邻接BFS | 22.19 | 15.63 |
| 以上合计 | **68.02** | **59.45** |

两次同输入均545,803前景pixel、582组件；mask SHA=`20d51e1e89684dcff45d6fa2fea83c7ce7a8ac7c4a1d2823bbf6fa189921a093`，组件JSON SHA=`59b37945826023ca3e72de03e82cc22d117440f9db388a92fa073237adc1f518`。逐组件深比较及总area=全部前景数量通过。小合成oracle覆盖斜线8连通、禁止跨行wrap、row-major组件顺序、1列及空mask，不改输入。

BFS占本次算法时间32.6%/26.3%，Gaussian更大；没有证据先投入新CC实现。微测还未包括Browser Canvas setup/draw/read或最后rect过滤，CPU调频/JIT/分配和实际重采样像素也不同，不能据Node的59–68ms认定真实页面约290ms必为Canvas、或认定BFS的浏览器收益上限只有22ms。

## 最小真实页面分项observer

只在`readingOrder.ts`加入既有`__shinobuColdStartInitMark` observer。它是function时计时，一次成功prepare聚合发送：

- `phase='reading-panels.prepare'`、startedAt/durationMs。
- sourceWidth/Height、scaledWidth/Height、componentCount、panelCount。
- canvasSetupMs、canvasDrawResizeMs、canvasReadMs。
- grayMs、gaussianMs、thresholdMs、borderInvertMs、componentsMs、rectFilterMs。

不开observer或传非function时不读取clock；循环、数组类型、8邻接、组件顺序和全部参数保持。Callback失败吞掉，不能导致panel fallback。原Canvas读错误仍由原prepareReadingPanels捕获并返回null；失败中途不会发假完整聚合。

小门`node benchmark/perf/src/check-reading-panels-observer.mjs`通过，执行0.50s：transpile真实源码确认语法、默认/非function零clock、成功仅一条record、原两panel结果及输入一致、observer异常不改输出、原Canvas失败fallback保留。没有运行build/typecheck或浏览器。

## Canvas路径与分项解释边界

扩展createCanvas实际为HTMLCanvas，源由`imageToCanvas`先画原HTMLImage，未在load阶段强制读取像素。Panel prepare向willReadFrequently=true的新Canvas进行1284×1800 drawImage，然后getImageData。前者可能消费原图未raster的draw/snapshot，后者可能完成缩放目标raster并复制RGBA；分项名字描述API窗口，不表示底层所有重采样都发生在draw返回前。

Chromium151的HTMLCanvas `GetImage`/`FinalizeFrame`会FlushCanvas；软件Canvas provider也会record后在Flush执行RasterRecord。因而实际canvasDrawResize/canvasRead需一起读，willReadFrequently不会证明draw同步结束全部绘制。[HTMLCanvas实现](https://github.com/chromium/chromium/blob/151.0.7922.34/third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d.cc#L783)、[软件provider](https://github.com/chromium/chromium/blob/151.0.7922.34/third_party/blink/renderer/platform/graphics/canvas_resource_provider.cc#L318)。

1284×1800为2,311,200 pixels，bordered1304×1820为2,373,280 pixels；RGBA、gray、Gaussian Float32 tmp/out、threshold、border mask、visited/Int32 queue约39.7MB的请求数组，另有原/工作Canvas backing。这里是数组请求总数，不是同时活跃内存或实际GPU VRAM；不能由此估GC延迟。既有mask gray使用另一缩放尺寸，直接复用会改变panel像素，当前不做。

主控已冻结源码，未实现BFS或其他新加速候选。正式目标验收使用相同image+cacheState的普通visible数据，不由诊断单次或此Node微测宣称达标。

## Chromium151真实分项：主图Canvas窗口约68%

主图质量QA在`.tmp/cold-budget/1790863277823-results.json`，第二图在`.tmp/cold-budget/1790863172428-results.json`。均为new-profile、带verifyinput/verifydet及分项observer的诊断运行，不作为普通中位数或固定预算验收。读取各原始report确认下表记录；无新浏览器/GPU运行或源码更改。

主图是既有2921×4096 fixture，scaled1284×1800；selected为当前完整downloadblob+lateinpaint组合，另一组再加displayinstant。第二图为`assets/readme/translated1.png`，1487×2048→1307×1800，对照原baseline与selected。

| 准备项（ms） | 主图selected | 主图+displayinstant | 第二图baseline | 第二图selected |
|---|---:|---:|---:|---:|
| canvasSetup | 0.0 | 0.0 | 0.1 | 0.1 |
| canvasDrawResize | 98.2 | 98.6 | 2.6 | 37.6 |
| canvasRead | 45.6 | 59.9 | 16.0 | 32.3 |
| gray | 6.2 | 6.4 | 12.2 | 11.7 |
| Gaussian | 31.1 | 39.2 | 80.9 | 38.4 |
| threshold | 3.3 | 2.9 | 2.4 | 4.2 |
| border+invert | 6.4 | 5.8 | 5.1 | 9.4 |
| BFS | 19.7 | 18.6 | 48.4 | 59.4 |
| rect过滤 | 0.2 | 0.2 | 0.1 | 0.2 |
| 整段duration | **210.7** | **231.6** | **167.8** | **193.3** |
| 组件 / 最终panels | 951 / 8 | 951 / 8 | 142 / 1 | 142 / 1 |

主图draw+read为143.8/158.5ms，占整段68.2%/68.4%；BFS只占9.3%/8.0%。Gaussian仍是纯数组算法中最大项，已用既有PixelFastPath。约290ms的历史warm值不能直接替换为本次210.7ms；这里只确认两个实际样本中主要时间在Canvas消费窗口。displayinstant在更后的显示阶段才起作用，不能把这两次早期panel差异归于该flag。

第二图中BFS59.4ms确为selected最大单项，但canvasDraw+read合计69.9ms更大，且CPU形态与主图不同。Baseline Gaussian未开既有PixelFastPath，80.9→38.4ms符合此前已优化的方向；这不是新增的Gaussian收益。相反，panel整段167.8→193.3ms仍增加25.5ms，draw+read增加51.3ms、BFS增加11.0ms。此完整组合同时改变初始化/准备时点，不能将BFS波动称作算法回退，也不能根据Gaussian单项变快称panel整体更快。

时间位置也不同：第二图baseline在页面at3326.7ms才prepare；selected在at157.9ms prepare。后者更早消费原Canvas，可能把原图首次raster/snapshot/缩放的成本移入panel窗口；与上节Canvas源码解释相符，但这些API计时未将浏览器内部每项分离，尚不能确切归因51.3ms。主图两组同样提前在at191.5/301.1ms prepare。PanelOverlap已与detector Session等待重叠，整段210.7ms不是可直接从全程扣除的串行余量。

真实浏览器主图951组件，而Node/libvips微测582组件；这再次说明不同重采样取得的像素不能替代浏览器质量门。两个浏览器主图均951/8，第二图均142/1；marker只记录数量，没有组件rect/hash，不能单靠数量认定所有组件完全相同。主控另行完成相同image+cacheState的原detector输入/三raw输出、完整OCR和最终RGBA门，全部通过。

当前结论：保持源码冻结。没有支持优先重写BFS或降低maxSide的证据；如后续确有新的预算缺口，应先定位Canvas draw/read窗口内的原图消费与缩放/读取成本，同时保持原重采样、像素与面板规则。未实施或承诺新的加速收益。

## SourceCanvasCpu：原生质量失败，产品改动已撤回

最终普通确认的fresh中位仍未满足固定2845.5ms预算后，主控授权临时实验：只在`image.ts`的`imageToCanvas`加入默认关闭的`__shinobuColdStartSourceCanvasCpu === true`。首次context为true时`getContext('2d', { willReadFrequently: true })`，否则保留原单参数`getContext('2d')`；仍按naturalWidth/Height创建、1:1 `drawImage(image,0,0)`，未改默认sRGB/unorm8/alpha/AA或后续读取源。与pixel owner协调，其native threshold函数的独立改动不被撤销。

实际原生门`.tmp/cold-budget/source-canvas-cpu-native.json`已**失败18/28项**。因此产品`imageToCanvas`已恢复原context调用；没有采用此旗标或继续其性能实验。独立native脚本改为只读提取原函数，要求`const ctx = canvas.getContext("2d");` exact token恰好出现一次，才注入实验guard。失败实验仍可复现，不再需要更改产品源文件。

HTML Standard将willReadFrequently标为读回优化提示；Chromium151在首次HTMLCanvas选raster模式时，true会选择PreferCPU。这改变后台工作内存/渲染路径，不改变请求的像素类型，但**不保证两条渲染路径逐字节一致，也不证明此前每次读图都重复GPU→CPU**。[Canvas设置](https://html.spec.whatwg.org/multipage/canvas.html#concept-canvas-will-read-frequently)、[Chromium151初始raster选择](https://github.com/chromium/chromium/blob/151.0.7922.34/third_party/blink/renderer/core/html/canvas/html_canvas_element.cc#L1440)。不能先认定主图143.8ms可全部删除。

直接调用已追全：正常orchestrator、bake中的shinobuRenderDebug/shinobuRenderFixtureDebug/shinobuBake，以及Node run-perf。Web Worker平台的OffscreenPipelineCanvas亦转发首次context options；正常默认flag未开启。其他原canvas/clone/helper不改。

模型输入来源已追清：detector WebGPU路径从原PipelineImage→platform.createImageBitmap(image)→runImage；扩展直接对原HTMLImageElement创建bitmap，Web平台直接复制原BitmapPipelineImage.bitmap。CPU/WebNN/WASM detector letterbox、bubble和OCR也使用原image独立预处理，不经originalCanvas。此旗标主要影响面板准备、mask灰度、inpaint源feeds/原图合成与typeset。因此四detector输入/输出SHA是必要门，单独通过不足以批准候选；须保留完整OCR/顺序、inpaint和最终PNG RGBA门。

初始小CPU检查通过，覆盖undefined/false/0/字符串true和布尔true、同size/image、一次context/draw、原null错误。撤回后该门改测isolated注入，并额外验证真实产品函数即使flag=true仍只调用原`getContext('2d')`；重新通过（0.68s）。`node benchmark/perf/src/check-source-canvas-cpu-browser.mjs --syntax-only`在只读单token注入后重新通过（0.90s），只解析生成的原生JS，没有开浏览器/GPU/build。

原生门直接提取真实extension loadImage与imageToCanvas：Canvas编码sRGB/P3 PNG→真实loadImage解码→原图copy，opaque/全部256alpha/fulltransparent×两色域×1:1/panel1800/mask2048/inpaint512共24项，加原fixture4项。每个缩放使用独立source pair，先draw target再读target，避免提前读baseline源导致CPU迁移。Context attributes需保持alpha/sRGB/unorm8且true/false flag对应；这是设置提示检查，不能当实际GPU backend探针。旧preread native门是在同cpu模式内部互比，不能替代本门。

由主控独占原生browser运行：

```powershell
node benchmark/perf/src/check-source-canvas-cpu-browser.mjs --browser-executable=C:/Users/STONE/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe --out=.tmp/cold-budget/source-canvas-cpu-native.json
```

该命令现在仅用于失败复现；可传`--fixture=assets/readme/translated1.png`替换fixture。任一像素不等先写结果再exit错误。WebGPU buffer probe不观察Skia内部Canvas分配，不能据其计数不变宣称VRAM不变。没有候选通过质量或实测加速的声明。

### 具体负证据

| PNG来源 | 1:1不同bytes | panel1800不同bytes | 2048测试尺寸不同bytes | inpaint512不同bytes |
|---|---:|---:|---:|---:|
| sRGB opaque | 0 | 1,177,676 | 1,517,985 | 760,575 |
| sRGB 256alpha | 10,935 | 1,290,317 | 1,660,584 | 832,141 |
| P3 opaque | 28,499 | 1,150,323 | 1,482,717 | 742,440 |
| P3 256alpha | 220,917 | 1,259,301 | 1,620,728 | 811,864 |
| 既有主fixture | 0 | 1,850,160 | 2,150,589 | 185,061 |

两色域全透明各四项均相同，其余见表。sRGB opaque的第一次panel差异已是4→3；但不能称所有差异都只±1，alpha样本还出现255→128等较大差异。Opaque与主fixture的1:1 copy相同仍不足以保证后续缩放一致，不能按opaque fallback绕过失败；不新增opacity metadata/parser，不替换插值或改变阈值来适配差异。由于在模型前的像素门已失败，未继续两图完整模型/PNG质量与普通性能实验。

## 保留GPU原图后的读回复用：暂未发现新的重复

继续只读追踪当前selected流程，`.tmp/cold-budget/1790863277823-results.json`提供了实际消费尺寸：

| 消费 | 实际尺寸 | 当前读取/复用 |
|---|---:|---|
| panel gray | 1284×1800 | panel prepare一次，order使用已prepared panels |
| mask gray | 1947×2731 | refineTextMask一次；已有PreparedTextMaskGray可按source身份/双维/length复用 |
| inpaint image feed | 512×512 | 原GPU source→原CPU target缩放后一次RGBA读取 |
| composition original | 2921×4096 | DirectPixels一次source getImageData；已有PreparedInpaintSource可复用同一次读取 |

这里mask实际不是2048：原`computeScaleFactor(rawMaskHeight,imageHeight)`为`max(min((rawMaskHeight-imageHeight/3)/rawMaskHeight,1),0.5)`；当前raw mask在原分辨率，所以scale=2/3。上节native门的2048是一项额外缩放测试尺寸，不是本组mask refine的真实size。主图mask gray为5,317,257个像素，与panel不同；第二图panel1307×1800，mask按同公式为991×1365，也不相同。

主图两份QA的mask `readGrayMs`仅31.4/34.4ms，inpaint `readOriginal`仅16.2/19.6ms且各一次。已有SourcePreRead把这两项提前并保存局部数据，在消费时检查source身份/尺寸/模式/长度，不符才回退原读法，消费后清除引用。它没有减少一个本来存在的第二次同尺寸读回，之前普通实验也没有稳定全程收益，不能重新将31+16ms或历史90–120ms隐藏上界记成新收益。

用全尺寸RGBA或panel gray在CPU Canvas再生成mask/inpaint缩放，会改变source backing或重采样输入路径；本次负门已说明1:1像素相同不够，不能如此替代原GPU source。只有实际请求尺寸和原context/图源条件一致时才有讨论相同gray复用的基础；当前两张验证图没有该重复，暂不新增cache、上下文模式或插值实现。
