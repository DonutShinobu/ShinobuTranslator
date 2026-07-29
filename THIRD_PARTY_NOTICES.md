# 第三方组件与模型声明

本文档记录项目中第三方模型与主要浏览器运行时的精确来源、许可证和当前发布状态。资产指纹与
`packages/model-manifest/manifest.json`、来源记录
`packages/model-manifest/publication-policy.json` 必须一致。

## 1) `detector.onnx`（文字检测）

- 精确对象：`manga-image-translator` `beta-0.3` Release 的
  `comictextdetector.pt.onnx`；本地文件与该对象逐字节相同。
- 原始来源：`https://github.com/dmMaze/comic-text-detector`
- 发行来源：`https://github.com/zyddnys/manga-image-translator/releases/tag/beta-0.3`
- SHA-256：`1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f`
- 许可证：`GPL-3.0`。同哈希 Hugging Face 镜像的 Apache-2.0 标签没有提供改变原始
  GPL 发行条款的授权证据，不能作为本资产的发布依据。
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
  资产时会输出明确提示，但不再作为个人开源项目的自动部署阻塞。
- 发布源码或构建产物时须保留本文件、适用的完整许可证文本、上游版权/NOTICE 和修改记录。
- 详细证据、Cloudflare 隐私事实和残余风险见
  `docs/web-public-beta-compliance-research.md`。

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

## 9) 免责声明

- 本文件仅用于工程合规记录，不构成法律意见。许可证冲突或权利范围不明确时，不以模型页
  标签代替权利人授权；是否公开分发由维护者结合上游材料自行决定。
