# 第三方组件与模型声明

本文档记录项目中第三方模型与主要浏览器运行时的精确来源、许可证和当前发布状态。资产指纹与
`packages/model-manifest/manifest.json`、来源记录
`packages/model-manifest/publication-policy.json` 必须一致。

## 1) `detector.ort`（文字检测）

- 上游精确对象：`manga-image-translator` `beta-0.3` Release 的
  `comictextdetector.pt.onnx`，SHA-256 为
  `1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f`。
- 派生记录：使用 ONNX Runtime `1.24.1` 执行
  `python -m onnxruntime.tools.convert_onnx_models_to_ort detector.onnx
  --optimization_style Runtime`，生成浏览器使用的 portable Runtime ORT 文件。
- 原始来源：`https://github.com/dmMaze/comic-text-detector`
- 发行来源：`https://github.com/zyddnys/manga-image-translator/releases/tag/beta-0.3`
- 派生文件大小：`94,863,096` 字节
- 派生文件 SHA-256：`0e9c3979e73092a56404c835e63d9894e7d94b50b356ee29e84ee6a32d65f7d9`
- 许可证：`GPL-3.0`。同哈希 Hugging Face 镜像的 Apache-2.0 标签没有提供改变原始
  GPL 发行条款的授权证据，转换后的派生文件也不改变该许可依据。
- 发布状态：**有条件放行，当前尚未批准上传**。公开分发前必须归档 GPL-3.0 许可证文本、
  对应源码/获取路径、版权归属和修改记录；上游关于训练数据与字体权利的提示仍需保留。

## 2) `PP-OCRv6_medium_rec.onnx` 与 `paddleocr_v6_dict.txt`

- 固定来源：`PaddlePaddle/PP-OCRv6_medium_rec_onnx` revision
  `50c7eacafc52fa7bcf4194e8cd08e46f8558504b`
- ONNX SHA-256：`9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba`
- 字典 SHA-256：`b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d`
- 许可证：`Apache-2.0`，与 PaddleOCR 官方仓库一致。
- 处理记录：ONNX 与固定 revision 的 `inference.onnx` 逐字节相同；字典由同一包
  `inference.yml` 的 `PostProcess.character_dict` 18,708 个条目按原顺序提取。
- 发布状态：**允许进入发布清单**，条件是随发布物保留完整 Apache-2.0 文本、上游版权
  归属和适用的 NOTICE。

## 3) `aot_inpaint_512.onnx`（去字修复）

- 已确认 checkpoint：`manga-image-translator` `beta-0.3` Release 的
  `inpainting.ckpt`
- checkpoint SHA-256：`878d541c68648969bc1b042a6e997f3a58e49b6c07c5636ad55130736977149f`
- ONNX SHA-256：`acdddccfdc32780c8947946814e9eea6a8b0d5b1880fb46f3be8389510f11689`
- 许可证依据：checkpoint 在 `GPL-3.0` 仓库和 tag 下发行。AOT-GAN 原实现的
  Apache-2.0 和另一份不同模型的 MIT 标签不能改变该 checkpoint 或当前派生产物的条款。
- 发布状态：**阻断**。仓库尚缺生成这一精确 ONNX 的导出器源码、命令、依赖版本、opset、
  导出者/日期与可复现输出记录；在补齐 GPL-3.0 适用材料和完整导出链或替换模型前不得上传。

## 4) `bubble.onnx`（气泡分割）

- 固定 checkpoint：`huyvux3005/manga109-segmentation-bubble` revision
  `f9a4108c4955136a810e5e92207972f3fb3a65fd` 的 `best.pt`
- checkpoint SHA-256：`4028152940f7c910f40192f46ede3b3f6c7129e5c76849c324d3564f8ac50198`
- ONNX SHA-256：`3da3317f6dffe27cf5c9396dc95d5324fb647e22adeb7bf304edbe921789f0a0`
- 许可冲突：模型页标注 Apache-2.0；当前精确 ONNX 的内嵌元数据写明
  `Ultralytics 8.4.75` 和 `AGPL-3.0 License`。
- 发布状态：**阻断**。在完成 AGPL-3.0 适用义务评估并补齐材料、取得覆盖该精确模型的其他
  授权，或替换模型前不得上传。还需核对模型页列出的训练数据集及其引用要求。

## 5) 主要浏览器运行时

- ONNX Runtime Web `1.24.1`：MIT，
  `https://github.com/microsoft/onnxruntime/blob/v1.24.1/LICENSE`
- React / React DOM `18.3.1`：MIT，
  `https://github.com/facebook/react/blob/v18.3.1/LICENSE`
- Vite `6.1.0`（构建工具）：MIT，
  `https://github.com/vitejs/vite/blob/v6.1.0/LICENSE`

发布构建应保留这些组件的版权与 MIT 许可证通知。库许可证本身不证明生产构建没有网络请求；
图片不外发必须由 CSP、发布边界检查和浏览器网络回归共同验证。

完整的 npm 生产依赖精确版本与 SPDX 许可证快照记录在
`THIRD_PARTY_DEPENDENCIES.json`。`npm run check:licenses` 会把实际安装树与该快照逐项
比对，并拒绝未复核的许可证表达式或静默漂移；这份清单不替代各包自身应随分发物保留的
LICENSE/NOTICE。

## 6) 分发与来源提示

- 本仓库根目录 `LICENSE` 为 `GPL-3.0`。
- `scripts/upload-r2-models.mjs` 会在任何 R2 写入前校验
  `packages/model-manifest/publication-policy.json`；存在 `conditional` 或 `blocked`
  资产时会阻止上传。
- 发布源码或构建产物时须保留本文件、适用的完整许可证文本、上游版权/NOTICE 和修改记录。

## 7) 应用图标（Donut icon）

- 来源：`https://www.flaticon.com/free-icon/donut_6402298`
- 作者：smashingstocks
- 许可证：Flaticon Free License（`https://www.flaticon.com/legal`）
- 本项目用途：浏览器扩展应用图标
- 署名要求：须注明 "Designed by smashingstocks from Flaticon"

## 8) 应用字标（Sour Gummy outline）

- 字体来源：`https://github.com/eifetx/Sour-Gummy-Fonts`
- Google Fonts 分发：`https://github.com/google/fonts/tree/main/ofl/sourgummy`
- 设计者：Stefie Justprince
- 许可证：SIL Open Font License 1.1（OFL）
- 本项目用途：将 `ShinobuTranslator` 文字转换为 SVG outline，用于 README 头图与扩展弹窗标题；不分发完整字体文件。
- 版权声明：Copyright 2018 The Sour Gummy Project Authors (`https://github.com/eifetx/Sour-Gummy-Fonts`)

## 9) Popup 的 shadcn/ui 控件

- 来源：`https://ui.shadcn.com/r/styles/new-york-v4/{component}.json`，于 2026-10-04 获取。
- 上游：`https://github.com/shadcn-ui/ui`，MIT，Copyright (c) 2023 shadcn。
- 本地源码：`apps/extension/src/popup/components/ui/`。
- 修改记录：调整本地导入路径，兼容 React 18 的 Button ref，向 Slider thumb 传递无障碍名称和值文本并保留装饰刻度，省略 Select 菜单的滚动箭头按钮，Popover 保留 popup 使用的基础组件。
- 完整许可证：`public/licenses/shadcn-ui.txt`，随 Chromium 和 Firefox 扩展构建复制。
- Radix、Lucide、Tailwind 相关 npm 依赖的精确版本和许可证包含在 `THIRD_PARTY_DEPENDENCIES.json`。

## 10) 连续曲率与同心圆角

- 来源：`https://github.com/diip3sh/tailwindcss-concentric`，版本 `0.1.0`。
- 许可证：MIT，Copyright (c) 2026 diip3sh。
- 用途：通过 `rounded-concentric` 和 `concentric-squircle` 生成网页、弹窗与页面浮层的圆角样式。
- 完整许可证：`public/licenses/tailwindcss-concentric.txt`，随网页及扩展构建复制。

## 11) 翻译按钮的文字、图标动效与玻璃光学

- Morphicons `1.7.1`：官方 npm 分发 `https://registry.npmjs.org/morphicons/-/morphicons-1.7.1.tgz`，上游 `https://github.com/guillermolg00/morphicons`，MIT，Copyright (c) 2026 Guillermo。用于 SVG 描边几何连续变形。
- Torph `0.1.3`：官方 npm 分发 `https://registry.npmjs.org/torph/-/torph-0.1.3.tgz`，上游 `https://github.com/lochie/torph`，MIT，Copyright (c) 2025 Lochie Axon。用于文字字素匹配、位置与透明度过渡。
- 本地运行模块：`apps/extension/src/content/core/ui/motion-vendor/motion-kit.js`；保留原版公开类型声明、完整 MIT 通知以及固定版本与完整性记录 `manifest.json`。`build.mjs` 对固定 Torph 输入做六项精确校验的适配：保留中断时零透明度、含中文状态按字素匹配并复用已有 LCS/ID 分配、让 `scale:false` 同时禁止进出场组缩放。
- 文字、图标模块的完整许可证：`public/licenses/morphicons.txt` 与 `public/licenses/torph.txt`，随 Chromium 和 Firefox 扩展构建复制。运行模块是本地自包含代码，不引入 CDN 请求；重建输入属于本地开发工具，不改变 npm 生产依赖快照。
- Glass HQ Liquid Glass 光学源码：`https://github.com/Glass-HQ/liquid-glass/tree/9f5bfc7daa7be5d20a41b94d841b8f065de655fc`，MIT，Copyright (c) 2026 Glass HQ。翻译按钮采用该仓库 Clear 材质的距离场折射、边缘覆盖与高光贴图、SVG 合成流程；这是网页实现，未分发 Apple 原生 Liquid Glass。
- 本地光学源码：`apps/extension/src/content/core/ui/liquidGlass.ts`。修改记录：将 WGSL 贴图计算移植到 CPU Canvas、适配按钮圆形端部与可变宽中段 SVG 位移，采用 Clear/light 的零磨砂与 33 点透光曲线。高光与黑色边缘阴影按源代码的 source-over 公式分层合成；同一层主光闲置固定为 45° 白色并保留原始双侧范围，忙碌时连续转粉，采用同一镜面与漫反射衰减。在运行时淡出整边底光，让两组相隔半周长的局部高光沿真实轮廓移动，每圈两次非线性加减速，快时拉长并带淡尾。保留尺寸与可见性生命周期，前景颜色取样同步应用透光曲线。未接入上游要求显式背景容器的 WebGPU 场景控制器。
- Glass HQ 完整许可证：`public/licenses/glass-hq-liquid-glass.txt`，随 Chromium 和 Firefox 扩展构建复制。
- 主光收尾保留当前位置与入射速度，沿轮廓向前滑到最近的半周等价静置位置，以不超过 320ms 的 Hermite 曲线减速；归位结束后恢复完整白光范围，支持中断、隐藏暂停与按钮尺寸变化。
- 按压反馈另移植同版本 `src/dom/interaction.ts`、`src/core/spring.ts` 与 `src/styles.css`：保留按下膨胀、拖动的弹性阻力与拉伸、松开的解析弹簧回弹及触点白色光晕。修改记录：独立于上游场景调度器运行，补充隐藏、失焦、禁用与销毁处理；保留原生按钮点击和键盘语义，按压反馈不改变固定 45° 边缘光照。
- Liquid DOM 前景颜色参考：`https://github.com/AndrewPrifer/liquid-dom/tree/dd342ab663d718e8b4edf4cd39983b9a873360a7`，MIT，Copyright (c) 2026 Andras Prifer。文字颜色选择使用该库 `ADAPTIVE_TINT.md` 的背景亮度分位值思路，针对通透按钮另行计算统一前景色。完整许可证 `public/licenses/liquid-dom.txt` 随 Chromium 和 Firefox 扩展构建复制。

## 12) 免责声明

- 本文件仅用于工程合规记录，不构成法律意见。许可证冲突或权利范围不明确时，不以模型页
  标签代替权利人授权；是否公开分发由维护者结合上游材料自行决定。
