# Firefox 优化验证 · 2026-10-07

已根据验证结果修改正式源码，并在原项目位置重新构建 Chromium 和 Firefox。Firefox 默认开启 22 项优化，保留分块结果传输；浏览器 detector 的初始化器内存设置及 CPU 路径的提前加载竞态已修正。修复后的原生浏览器与仓库检查结果见末节「正式修复与回归」。下面保留修复前的性能矩阵和失败记录，其中的「当前版」指修复前基线。

## 修复前验证

Firefox 上有实测收益，但当前不能直接开启 Chromium 的全部 27 项预设。完整候选在正式性能样本中首次处理减少约 6.0%，连续处理减少约 29.3%；附加大图测试暴露了 Blob 图层读取挂起，CPU 回退还存在一个与这些新增开关无关的模型内存问题。失败样本保留，不能把本次结果称为全部稳定通过。

测试使用原生 Firefox 157.0、真实 MV2 扩展背景页和 ONNX Worker，分别创建隔离 profile；没有使用 Playwright 的定制 Firefox，也没有修改用户浏览器配置。固定版本 BuildID `20260924084938`，SourceStamp `8eb25af4acf031ab1e06abf1a912275083c820ed`。Windows 测试机有 RTX 5070 Ti、32 GB 内存；Firefox 的适配器信息受隐私限制，四个模型的实际 WebGPU provider 由运行结果核实。另用原生 Firefox 140.0 常规发行版验证较旧版本的 WASM 路径，未覆盖 ESR。

该阶段产物取自修复前的 `dist-firefox`。四组候选仅存在于 `.tmp`：当前 Firefox（全部开关关闭、完整 ORT）、仅换裁剪 ORT、裁剪 ORT 加 18 项通用开关、裁剪 ORT 加全部 27 项开关。最后一组还在临时 Worker 中去掉 shader warmup 的 Chromium UA 限制，没有伪造 Firefox UA。模型、WASM、字体逐文件 SHA 完全一致。修复前的正式 Firefox 默认配置未开启这些开关，候选验证阶段没有修改产品源码。

## 性能与结果一致性

三轮交替顺序测试，每组均包括新 profile 的首次处理和同一浏览器里的第二次处理；另各测一次关闭浏览器后沿用原 profile 的重启处理，共 28 次。没有清空操作系统文件缓存或显卡驱动缓存，“首次”指扩展/模型运行环境的新 profile 首次处理。每次使用新页面并触发实际翻译入口，以译图真实加载完成为终点；性能运行关闭调试日志和额外质量读回。

主图为 `benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png`，2921×4096、7,915,903 字节。正式计时使用本地模型和原文排版模式，排除远程翻译服务的网络波动。冷/热列为三次中位数，重启列只有一次样本。

| 候选 | 首次处理 | 连续处理 | 重启后首次，n=1 |
| --- | ---: | ---: | ---: |
| 当前 Firefox | 35.317 s | 3.160 s | 35.630 s |
| 仅裁剪 ORT | 35.140 s | 3.134 s | 35.067 s |
| 18 项通用优化 + 裁剪 ORT | 33.672 s | 2.428 s | 33.615 s |
| 27 项完整优化 + 裁剪 ORT | 33.206 s | 2.233 s | 32.573 s |

完整候选首次少 2.111 s（6.0%），连续处理少 0.927 s（29.3%）。通用候选的对应收益为 4.7% 和 23.2%，说明多数收益来自通用路径；这不是逐个开关的独立归因。仅裁剪 ORT 让 Worker 从 842,799 减至 399,582 字节，减少 52.6%，耗时差异仅 0.5%/0.8%，不能认定有明确速度收益。重启差异只作观察，不推断稳定收益。

全部 28 次均完整运行检测、气泡、OCR、去字四个 WebGPU 模型，结果 PNG 字节及独立解码 RGBA 的哈希全部相同。另行质量诊断比较了实际检测输入、三个检测输出，以及去除随机 ID 后的 17 个 OCR 区域和 9 个合并/排序区域，均完全一致。GPU CTC 的 9 次实际推理共 469 行，校验 class index 和 float32 最大概率通过，没有触发 CPU CTC 回退。最终像素从结果 Blob 独立解码，避免 DOM 图片切换期间仍返回旧位图。

还分别在当前版和完整候选中调用了真实 `google_web` 翻译服务，中文翻译/排版流程完成，结果 PNG 和 RGBA 相同。这两次受网络和诊断负载影响，不用于候选速度比较。

## 实际生效的路径与失败

- **Worker PNG、像素路径、并行读回等能运行。** 主流水线实际观察到 ImageBitmap PNG Worker；主结果及 18 张图层 PNG 完成编码。检测输出并行读回、紧凑 CTC 输出、字体 Blob URL 都有运行记录。独立含透明度 PNG 探针的字节和 RGBA 与原路径相同。
- **Canvas 原生阈值没有收益。** Firefox 157 的 `getContextAttributes()` 没有 `colorType`，现有能力检查在四种 hint 组合都走 CPU 回退。`MaskNativeThresholdGpu` 是 Canvas2D 读取偏好，不表示遮罩用了 WebGPU。
- **Shader 复用有命中，预热没有消除首次慢。** 冷 profile 虽请求了打包模板，但浏览器特征 key 不同，未观察到异步预编译。已有 Firefox shader 历史时，附加诊断记录 110 次异步尝试、108 次成功、51 次复用命中；两次在并行诊断负载下因资源不足失败，正常创建路径仍完成且结果一致。这不是正式串行计时或资源压力稳定性认证。当前 Firefox 源码仍保留已知 Naga HLSL workgroup 整体零初始化实现，可能带来编译等待；本次未用 Gecko profiler 将每一段耗时归因到编译器。[固定版本源码](https://hg.mozilla.org/releases/mozilla-release/file/8eb25af4acf031ab1e06abf1a912275083c820ed/third_party/rust/naga/src/back/hlsl/writer.rs#l2009)。
- **Blob 基础往返通过，但实际大图失败。** 之前遮罩卡住的原图 `HT6tujdbgAA79ZL.jpg`（3071×4096）在当前版完整成功。完整候选多次停在收到 `result-meta` 和 `complete` 之后，串行复测也复现。遮罩计算为 349/355 ms，卡点不是遮罩算法。更细的临时探针显示：4 字节长度头和 3377 字节 JSON 元数据立即读完，随后 1,469,404 字节 bubbleMask 的 Blob slice `arrayBuffer()` 一直不返回。产品结果 promise 正在等待 `unpackEditableImage`，尚未进入测试脚本的译图解码等待，因此不是计时 observer 的问题。只关闭 `StructuredClone`、其余 26 项仍开启的串行单变量对照完整成功；检测输入、三个输出、OCR/排序、PNG 字节和离线 RGBA 与当前版全部一致。该对照确认 Firefox 应保留既有分块结果传输；尚未定位 Gecko 内部导致读取挂起的实现原因，也不能以一次成功认证所有剩余开关。
- **CPU 回退有现存正确性缺陷。** Firefox 157 禁用 WebGPU，以及 Firefox 140 默认 WASM 时，当前版和完整候选均出现有效检测输入却返回三个全 NaN 输出，随后被误当作“没有文字”结束。只在临时 Worker 入参关闭 detector 的 `useOrtModelBytesForInitializers`，两个版本都恢复四模型完整 WASM 流程；当前/完整候选检测输出全部有效、OCR/顺序及 PNG/RGBA 相同。该选项要求模型字节保留至 Session 销毁，而当前 ORT Web 创建 Session 后释放这块 WASM 内存；单变量对照和官方生命周期要求一致。[ORT 1.27 官方约束](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.27.0/include/onnxruntime/core/session/onnxruntime_session_options_config_keys.h)。最小修正是删除浏览器 detector 默认的借用初始化器设置；仅限定到 WebGPU 不能普遍保证安全，因为 GPU 模型也可能有 CPU 节点回退。

附加测试还保留了两项稳定性限制：`translated1.png` 的当前版原始尝试曾停在气泡阶段，临时安全初始化器的重测成功并与完整候选逐字节相同，但不能据此证明该挂起只有一个原因；Firefox 140 临时完整候选第一次在气泡阶段失败，后续两个新 profile 成功，第一次底层错误没有捕获。已完成的质量对照不代表这些失败已经得到正式修复。

故障注入也显示 PNG Worker 构造失败会拒绝任务，没有主线程 PNG 自动重试；Blob 图片加载失败没有 FileReader 自动重试。字体路径有源码回退逻辑，但没有做全部原生故障组合测试。

## X 图片获取与建议

对 `large`、`orig`、`4096x4096`、`medium` 做了 32 个本地跨源样本及两个真实 `pbs.twimg.com` URL 测试。默认配置下的 12 个主对照，无论保留 Origin、移除 Origin，还是同时调整 CORS 响应头，`<img>` 加载后的第一次 fetch 都额外请求完整 200，第二次 fetch 才命中。仅改凭据或仅关 FETCH 分区均不够；两者同时调整的诊断正对照才能复用。Firefox 的 fetch/XHR 分区和匿名加载缓存上下文共同导致这项差异。[Mozilla HTTP 缓存说明](https://firefox-source-docs.mozilla.org/networking/cache2/doc.html)。诊断只修改隔离 profile。

真实 4096×4096 图片原生 fetch 首次/重复为 1116/16 ms，移除 Origin 为 1102/18 ms；medium 图片为 267/2 ms 和 631/2 ms。网络样本不能比较几百毫秒的小差异，但都证明第一次仍要下载。真实 URL 是从本地测试页请求，未使用登录后的 X 页面，因此不宣称覆盖其所有站点行为。

建议先修现存 detector 内存设置，并让 Firefox 的流水线结果保留分块传输，再评估其余优化的默认开启。ORT 裁剪可减少体积；通用路径及 GPU CTC/并行读回有迁移价值，但本次组合测试不能替代逐项稳定性判断。Canvas 原生阈值、直接照搬 X 移除 Origin 缓存方案没有实测收益；shader 预热也不能承诺消除首次几十秒等待。

机器可读数据、候选开关/资源哈希、28 次原始计时和失败索引保存在同目录 [JSON 汇总](firefox-optimization-validation-2026-10-07.json)。原始浏览器报告和临时可运行校验保留在 `.tmp/firefox-optimization/`；X 请求记录在 `.tmp/firefox-x-cache-20261007/`。复查修复前性能可运行 `node .tmp/firefox-optimization/run-matrix.mjs`，正确性汇总可运行 `node .tmp/firefox-optimization/build-quality-summary.mjs`，原图分块对照可运行 `node .tmp/firefox-optimization/check-original-chunk-result.mjs`。`write-final-report.mjs` 只生成修复前报告，不包含下面的正式修复回归。

## 正式修复与回归

正式 Firefox 采用 Chromium 预设中的 22 项优化，排除 `StructuredClone`、`MaskNativeThreshold`、`MaskNativeThresholdGpu`、`ShaderTemplates`、`ReuseShaderPipelines`。结果图层继续使用既有 base64 分块协议，避免已复现的 Blob slice 读取挂起。两个浏览器共用裁剪后的 JSEP JS，保留 WebGPU、WebNN 和 WASM；模型、配套 WASM 和字体不变。Firefox Worker 约 401 KB，修复前基线为 843 KB。

浏览器 detector 不再默认设置 `useOrtModelBytesForInitializers`，由 ORT 管理初始化器内存；显式实验覆盖仍可用。提前创建其他模型 Session 仅在 detector 的实际 provider 为 WebGPU 时运行，CPU/WebNN 路径按流水线阶段正常加载，避免 CPU 推理阻塞 Worker 时并发 Session 的超时计时器到期。此处修正的是已经确认的内存生命周期问题和加载竞态；没有声称捕获修复前每次气泡阶段失败的底层原因。

回归直接使用这次正式构建的复制品，未覆盖 22 项预设，也没有临时关闭初始化器选项。质量探针仅加入读回与记录，修改后的文件保留正式构建正文作为逐字节一致的后缀。原生浏览器的完整任务结果如下：

| 路径 | 样本与次数 | 检查结果 |
| --- | --- | --- |
| Firefox 157 WebGPU | 主图两次、3071×4096 原图一次、`translated1.png` 一次 | 四模型均运行完成；PNG 字节、独立解码 RGBA、OCR 内容与顺序均与修复前对应成功参考一致 |
| Firefox 157 禁用 WebGPU | 主图一次 | 四模型 WASM 完整完成；检测三个输出全部有限，NaN/Infinity 均为 0；结果与先前安全初始化器参考一致 |
| Firefox 140 常规版 WASM | 主图一次 | 四模型完整完成；检测三个输出全部有限，NaN/Infinity 均为 0；结果与先前安全初始化器参考一致 |

主图热轮有一个 OCR 置信度与冷轮参考不同：同一竖排图块的文字「いろはっ!」、位置及顺序相同，置信度从 0.9715989500793399 变为 0.9039181892717819。修复前质量参考仅有冷轮；现有 OCR 策略在冷轮将首块单独以 `[1,3,48,234]` 输入，热轮将它合入 `[2,3,48,256]` 的宽度分组，实际 batch/padding 不同，不能要求跨这两种输入的置信度逐字节相同。两值均高于 0.2 接受阈值，本样本两轮没有后过滤候选，排序记录及最终 PNG/RGBA 完全相同。置信度参与后续处理，不能笼统视为仅调试字段；本次只确认它未改变这个样本的结果，完整差异保留在 JSON。

以上六个质量回归任务均实际走分块结果传输，译图显示完成，未出现先前的大图 Blob 图层读取挂起。CPU 的三个检测输出分别含 451,584、1,048,576、2,097,152 个数值，全部通过有限性检查。测试范围仍限于本机 Windows 与上述版本、样本，不等同于所有平台稳定性认证。

另用没有额外质量读回的正式构建复制品，跑了一次新 profile 首次处理和一次同浏览器连续处理，分别为 **38.565 s / 2.427 s**，PNG/RGBA 与主图参考一致。这是修复后的 22 项预设，每种只有一个样本；不能与上面的 27 项候选矩阵混在一起，不能据此承诺首次或连续处理的稳定加速比例。

仓库检查全部通过：175 个测试文件、1481 项测试；各工作区及测试/benchmark 类型检查；双浏览器构建和重复构建一致性；39 个共享产物校验（包含 Worker 正文）；架构边界与 AMO 元数据检查。Firefox lint 为 0 个错误、6 项已审计依赖警告，优化预设迁移只更新对应生成文件的哈希，保留前序 CI 修正中已经审计的告警规则。

正式产物在 `apps/extension/dist-firefox` 和 `apps/extension/dist-chromium`，没有复制到 Downloads。修复后的原始报告是 `.tmp/firefox-optimization/postfix-*.json`；离线回归校验入口为 `node .tmp/firefox-optimization/summarize-postfix.mjs`，汇总同步收录在上述 JSON 的 `implementationFollowUp`。
