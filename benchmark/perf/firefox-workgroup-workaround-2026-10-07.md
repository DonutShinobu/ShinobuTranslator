# Windows Firefox 冷启动绕过验证 · 2026-10-07

本报告保留当时的实验状态。原始报告、profile 与实验脚本位于本机未提交的 `.tmp/`，普通仓库 clone 不包含这些材料，相关链接仅供保留该目录的本地复核。

正式扩展已采用较小的 ORT WebGPU 矩阵分块。在本机原生 Firefox 157.0 的三轮交替对照中，主图首次处理的中位数从 **34.889 s 降至 8.344 s（减少 76.1%）**；连续处理中位数为 2.635 / 2.589 s，未观察到明显热运行回退。三张图、四次质量回归均与原构建精确一致。

## 实现与范围

`scripts/build-jsep.mjs` 在构建已锁定的 ORT 1.27.0 JS 时，仅为 Windows Firefox 选择 4×4 工作组，替代默认 8×8；两个 packed MatMul generator 的默认 inner tile 从 32 改为 16。Conv2D、MatMul、ConvTranspose 的调度、分块边界及缓存提示随原 ORT generator 重新计算。标量卷积和 vec3 路径仍使用各自原有的 tile 计算规则。

这使常见 vec4 共享矩阵从 32×8 缩至 16×4，将单变量容量从 4096 B 减至 1024 B，降低 Naga 整体数组清零触发的 DXC 编译成本。仍保留浏览器要求的清零、原模型及 WebGPU 后端。Chromium、其他平台的 Firefox 使用原参数；配套 WASM、模型和字体未修改。ORT 版本和五个源码替换位置均有构建断言，升级后须重新验收。

本次改动作用于扩展的自建 JSEP JS；网页版目前仍直接打包上游 ORT，不包含此构建补丁。

上游 [wgpu #7443](https://github.com/gfx-rs/wgpu/issues/7443) 和 [修复 PR #10314](https://github.com/gfx-rs/wgpu/pull/10314) 在检查时仍未关闭。Firefox 仍生成整体 workgroup 清零；网页不能关闭它。这里缩小数组，而非修改浏览器内部编译器。上游修复进入 Firefox 后，应重新测量再恢复默认分块。

## 无质量探针的完整计时

固定原生 Firefox 157.0（BuildID 20260924084938），主图 2921×4096；使用真实 MV2 扩展、四个本地模型、原文排版模式，以译图加载完成为终点。每组启动一个新的隔离 profile，连续处理两次；顺序为原版/绕过、绕过/原版、原版/绕过。Worker 未注入质量读回或哈希探针；两组使用相同的内容页计时与结果采集。

| 轮次 | 原版首次 | 绕过首次 | 原版连续 | 绕过连续 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 34.435 s | 8.344 s | 2.570 s | 2.671 s |
| 2 | 34.889 s | 8.287 s | 2.635 s | 2.546 s |
| 3 | 35.106 s | 8.600 s | 2.702 s | 2.589 s |
| 中位数 | **34.889 s** | **8.344 s** | **2.635 s** | **2.589 s** |

12 次计时任务全部完整完成，四个实际 provider 均为 WebGPU，最终 PNG 与 RGBA hash 均与主图参考一致。模型和 WASM 文件逐个哈希一致，两个 Worker 在计时前后均未变化。原版 Worker SHA-256 为 `62593352fb5b7e01c7b7902725b0cbeb28bba66260f09874ec619fc84d69ce29`；绕过版为 `9725d653441cb3b994a9230bec594cae309b210be1b73e05ced20460e6e389b2`，只增加 240 B。

“首次”指该 profile 的第一次扩展/模型处理，未清空操作系统或驱动缓存；三轮、单机结果不代表所有设备的加速比例。本轮未重新测 Chrome。

## 正确性与检查

| 质量样本 | 次数 | 与原版对应温度的严格对照 |
| --- | ---: | --- |
| 主图 2921×4096 | 冷、热各 1 次 | 全部一致 |
| 原问题图 HT6tujdbgAA79ZL.jpg，3071×4096 | 冷 1 次 | 全部一致 |
| translated1.png，1487×2048 | 冷 1 次 | 全部一致 |

严格比较检测输入及 blk/seg/det 三输出的维度、字节数、SHA；OCR 全字段（含置信度、坐标和顺序）、完整排序记录；PNG 字节与 sharp 独立解码 RGBA。各轮均完成四模型 WebGPU 流程，保留结果分块传输，没有记录到任务错误。未独立采集气泡、OCR 输入和 inpaint tensor，因此不声称这些中间 tensor 逐字节一致。

全仓 176 个测试文件、1483 项测试通过；扩展及测试类型检查、双浏览器构建、39 个共享产物校验、重复构建一致性、架构边界通过。Firefox lint 为 0 错误、6 项原有依赖警告，仅更新生成 Worker 的审计哈希。正式产物在 `apps/extension/dist-firefox` 和 `apps/extension/dist-chromium`。

曾试验按行拆 workgroup 数组：代表 shader 编译有改善，但完整质量运行的连续处理变慢，未保留该实现。

## 复查入口

- 单元检查：`npx vitest run tests/workers/firefoxMatmul.test.ts`，验证三个真实 ORT 源文件、平台分支及源码漂移断言。
- 原生性能重跑：`node .tmp/firefox-workgroup-validation/run-performance.mjs`；原始六组计时及汇总在同目录 `performance-*.json`、`performance-summary.json`。
- 离线质量复查：`node .tmp/firefox-workgroup-validation/compare.mjs`；输入报告、保存 PNG 和 `quality-summary.json` 在同目录，原版参考在 `.tmp/firefox-optimization/`。
- shader 候选实验：`.tmp/firefox-workgroup-workaround/probe.mjs`、`result-ort.json`。候选编译耗时不替代上面的完整计时。
