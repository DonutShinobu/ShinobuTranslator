# Paddle 冷启动验证

## Goal

在不做页面加载时预加载、不改变检测效果的前提下，验证 Paddle OCR 冷启动首图提速的高价值路线，并用同一套浏览器 benchmark 数据决定后续是否进入产品实现。

本任务优先回答三个问题：

1. 用户点击翻译后，是否可以在 detect/bubble 窗口内准备 Paddle session/字典，降低 OCR 阶段等待。
2. `PP-OCRv6_small_rec` 相比当前 `PP-OCRv6_medium_rec` 是否能显著降低 cold total/cold OCR，同时保持可接受识别质量。
3. WebGPU 静态 shape、`enableGraphCapture`、受控 warmup 是否对首张图真实等待有净收益，而不是只把成本挪到其它阶段。

## Requirements

- 新建分支执行验证，避免污染 `master`。
- 复用现有浏览器 Paddle profile benchmark，必要时只做 benchmark-only 开关或窄工具改动。
- 不修改 detector 模型、输入尺寸、阈值、NMS 或 mask 后处理。
- 不做页面加载时预加载；允许用户触发 pipeline 后的懒准备、session cache 复用和实验性 warmup。
- 保留当前产品默认 `Paddle = paddleocr_v6_medium`，small 只作为测试/验证候选，除非数据支持后续产品决策。
- 输出 cold run 与 warm median 的对照数据，至少包含 total、detect、bubble、OCR、Paddle session、Paddle inference、首个 inference、region 数、有效 OCR 数和样本文本。
- 对可能引入行为变化的路线记录识别文本差异，不只看速度。

## Confirmed Facts

- 当前运行时 `paddleocr_v6_medium_rec` 注册为 WebGPU/WebNN/WASM fallback，模型约 76.6 MB。
- 本地存在 `PP-OCRv6_small_rec.onnx`，模型约 21.2 MB，元数据与 medium 兼容：输入动态 batch/width，输出类别 18710，使用同一 v6 字典。
- 归档任务显示 WebGPU warm OCR 已是 160-260ms 级别；cold OCR 主要被首次 WebGPU inference/编译支配，首个 inference 曾观测到约 7.88s 到 13.57s。
- WASM cold OCR 有时更短，但 warm OCR 约 3.5s，默认切 WASM 不适合当前产品目标。
- 当前 orchestrator 的 OCR runtime probe 仍准备旧 `ocr_encoder`/`ocr_decoder`，不是 Paddle medium session。
- 当前 Paddle provider 已有 width-bucket batch 和 WebGPU `coldFirstSerial`；本任务不重复验证已经证明低价值的无条件固定 320 串行方案。

## Acceptance Criteria

- [x] 建立可重复运行的浏览器 benchmark 命令或开关，能比较当前 baseline、Paddle trigger-after prepare、small candidate、以及 WebGPU warmup/graph-capture 实验。
- [x] 至少跑出 baseline 与两条候选路线的 cold 数据；如果某条路线环境不支持，需要记录准确失败原因。
- [x] 每个报告能区分 session 准备、preprocess、inference、CTC decode、首个 inference 和 warm median。
- [x] 最终结论按收益、风险、实现成本排序，并明确推荐进入产品实现的路线。
- [x] 验证过程不改变检测输出，不引入页面加载时模型常驻预加载。

## Out of Scope

- 不替换或调参 detector。
- 不把 small 直接改成用户默认选项。
- 不做模型训练、重新导出 Paddle 模型或上传图片到远端服务。
- 不把 WASM 作为默认 provider 方案，除非本任务数据推翻已有 warm 性能结论。

## Open Questions

- 无阻塞问题。用户已要求按推荐路线开新分支并进行测试验证。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
