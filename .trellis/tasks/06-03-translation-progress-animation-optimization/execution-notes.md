# 2026-06-03 执行记录

## 已实现

- 新增 `ProgressJankMonitor` 和 worker perf trace，单次翻译会输出 `[shinobu:jank]`，debug log 开启时写入 `progressJank`。
- 保持 `src/content/core/ui.ts` 不变，药丸 spinner、扫光、打字机、宽度 transition 等视觉效果未改动。
- 主线程可切分循环加入 cooperative yielding：OCR 预处理/分块间隔、mask refinement、inpaint pre/post、typeset region 循环。
- OCR 浏览器 provider plan 改为 `["webnn", "wasm"] -> ["wasm"]`，避免 OCR WebGPU 造成持续慢帧。
- worker session cache 改为按 `modelKey + provider plan` 区分，避免运行时探测污染后续 provider 选择。
- inpaint 预加载移动到去字阶段，避免 inpaint 初始化挤占 OCR 阶段。
- inpaint 保持 WebGPU 优先，避免 WASM inpaint 把总流程从约 47s 拉长到约 58s。
- OCR batch decode 输出不再回传主线程已有的 `imageData/imageDims`，输出估算从约 3.13MB 降到约 1.36KB。

## 已丢弃实验

- mask canvas 分块 `getImageData/putImageData`：实测让 `mask_refine` 更慢、慢帧更多，已撤回。
- inpaint 跳过 WebGPU：慢帧略少，但总耗时明显增加，不符合“不要拖慢整个流程”。

## 最终真实药丸 smoke

环境：2921x4096 fixture，`processMode=erase`，debug log 关闭，MV3 extension 真实 content script，悬停快捷翻译入口。

- 总耗时：约 47.7s。
- rAF p95：约 8.5ms。
- 最大 frame delta：约 275ms。
- `over50Count`：约 43。
- UI render：总耗时约 33.6ms，最大约 21.6ms。
- OCR worker 输出 payload：约 1.36KB。

## 结论

药丸 UI 自身不是主要瓶颈；本轮已把“持续很卡”的问题收敛为少数模型/Canvas 边界尖峰。剩余尖峰集中在 detect 输出/后处理、OCR worker 完成边界、inpaint WebGPU 尾段和最终 `canvasToBlob`。

## 后续候选

- 若还要进一步压低最大尖峰，下一步应评估把 detector postprocess / mask canvas 构建迁入 worker 或 OffscreenCanvas，而不是继续改药丸 UI。
- `canvasToBlob:result` 在大图上仍可能产生 200ms 级异步耗时；如果用户主观仍看到完成瞬间卡顿，可以单独评估最终输出编码 worker 化或分辨率相关策略。

## 2026-06-03 追加：spinner 卡顿复测与第二轮优化

用户确认左侧 spinner 本身也卡，不只是阶段文字/打字机卡顿。真实 UI hover 翻译路径复测后确认：

- UI render 本身仍不是主瓶颈，最终复测 `renderCalls=18`、`renderTotalMs≈30.1ms`、`renderMaxMs≈18.1ms`。
- 卡顿来源混合：JS long task、WebGPU/worker 返回边界、GPU/合成压力都会拖慢 rAF；不少 long frame 的 blocking duration 很低，说明单纯继续切 JS 循环不能完全解决 spinner 观感。
- spinner 旧实现同时做外层旋转和 SVG `stroke-dasharray/stroke-dashoffset` 动画，容易触发每帧重绘；已改为静态圆弧 + `transform: rotate()`，保留“左侧转圈加载”语义，降低 SVG stroke 重绘压力。
- `detect` 阶段不再提前启动 OCR session 预加载，避免检测、OCR 模型创建和 detector WebGPU 输出在同一阶段叠加。
- 正常 pipeline 不再为检测/OCR阶段默认复制整张大图绘制中间预览框，避免大图 `drawImage`/canvas 复制在阶段边界制造长任务。
- `detect`、`bubble`、OCR worker 返回续接点增加 cooperative yielding；bubble mask decode 只扫描候选 mask 可能覆盖的像素范围，避免每个气泡扫整张图。

最终真实 UI smoke（2921x4096 fixture，`processMode=original`，debug log 关闭，MV3 content script，hover 快捷翻译）：

- 总耗时约 `47.5s`，功能完成且返回 translated。
- rAF `p95≈8.5ms`，`maxDelta≈266.6ms`，`over50Count=39`，`over100Count=19`。
- `detect`: `duration≈1866ms`，`maxFrameDelta≈224.9ms`，`longTaskCount=1`。
- `bubble`: `duration≈1071.8ms`，`maxFrameDelta≈100ms`，`longTaskCount=1`。
- `ocr`: `duration≈26909.9ms`，`maxFrameDelta≈116.6ms`，`longTaskCount=1`。
- 仍有剩余尖峰集中在 detector WebGPU 输出、OCR worker 完成边界、inpaint WebGPU 尾段和最终输出编码；下一步若继续压低最大尖峰，应优先评估 worker 化 detector 后处理/输出裁剪，以及 inpaint WebGPU 对合成线程的影响。
