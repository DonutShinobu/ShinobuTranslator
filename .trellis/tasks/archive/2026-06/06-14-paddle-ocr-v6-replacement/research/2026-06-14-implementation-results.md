# PP-OCRv6 实现记录

## 官方 ONNX 来源

- PaddlePaddle 已在 Hugging Face 发布官方 ONNX 仓库：`PaddlePaddle/PP-OCRv6_small_rec_onnx` 和 `PaddlePaddle/PP-OCRv6_medium_rec_onnx`。
- small 仓库包含 `inference.onnx`（约 21.2 MB）和 `inference.yml`（约 151 kB）。
- medium 仓库包含 `inference.onnx`（约 76.6 MB）和 `inference.yml`（约 151 kB）。
- 官方 ONNX model card 说明 ONNX 使用方式需要 `--engine onnxruntime`。

参考链接：

- https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/tree/main
- https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/tree/main
- https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx

## 实现偏差

- 原计划是本地执行 Paddle2ONNX 转换；实现时改为使用官方 ONNX 文件，原因是官方已发布可直接用于 ONNX Runtime 的 small/medium 资产。
- `inference.yml` 中 `PreProcess.DecodeImage.img_mode` 为 `BGR`，因此运行时代码新增了 manifest 级 `channelOrder` 配置。v5 保持默认 `rgb`，v6 small/medium 使用 `bgr`。
- v6 small/medium 的 `character_dict` 完全一致，均为 18708 个条目。生成字典时必须保留全角空格 `　`，不能对 YAML 标量使用会吃掉 Unicode 空格的 `trimEnd()`。
- large ONNX 文件仍按现有项目规则作为本地模型资产处理，不通过 git 追踪；`paddleocr_v6_dict.txt` 需要追踪，因为它是 manifest 合约的一部分。

## 元数据验证

命令：

```bash
npm run models:check-paddle-ocr -- public/models/PP-OCRv6_small_rec.onnx public/models/paddleocr_v6_dict.txt
npm run models:check-paddle-ocr -- public/models/PP-OCRv6_medium_rec.onnx public/models/paddleocr_v6_dict.txt
```

结果：

- small 输入名 `x`，输出名 `fetch_name_0`，冒烟输出形状 `[1, 40, 18710]`，`18708 + blank + space = 18710`。
- medium 输入名 `x`，输出名 `fetch_name_0`，冒烟输出形状 `[1, 40, 18710]`，`18708 + blank + space = 18710`。

## Node OCR 基准

命令：

```bash
npm run bench:ocr-debug -- --ocr-engine=all --runs=2
```

样本：

- `benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png`
- 检测区域数：14
- Node 后端：CUDA 不可用，回退 CPU

结果：

| 引擎 | 冷 OCR | 热 OCR | 有效 OCR | 样本文本 |
| --- | ---: | ---: | ---: | --- |
| `paddleocr` | 632.54 ms | 269.38 ms | 14/14 | `いろはっ!`, `壁ドン!`, `はあ?` |
| `paddleocr_v6_small` | 734.87 ms | 246.38 ms | 14/14 | `いろはっ！`, `壁ドン！`, `はあ？` |
| `paddleocr_v6_medium` | 1071.55 ms | 333.76 ms | 14/14 | `いろはっ！`, `壁ドン!`, `はあ？` |

观察：

- 在该样本和 CPU 条件下，v6 small 冷启动略慢于 v5，但热 OCR 略快。
- v6 medium 冷/热都更慢，且该样本未显示出明显优于 small 的文本输出。
- v6 small 的日文标点输出更贴近原文全角标点。

## 浏览器冒烟

命令：

```bash
npm run bench:browser-ocr-smoke
```

结果：

- 浏览器：Playwright Chromium `Chrome/145.0.0.0`
- 环境：`secureContext=true`，`crossOriginIsolated=false`，`navigator.gpu=true`
- 内置 48px encoder/decoder：WebGPU session 创建和最小 decode 通过。
- Paddle v5：WebGPU session 创建，输出形状 `[1, 40, 18385]`，字典 18383，校验通过。
- Paddle v6 small：WebGPU session 创建，输出形状 `[1, 40, 18710]`，字典 18708，校验通过。
- Paddle v6 medium：WebGPU session 创建，输出形状 `[1, 40, 18710]`，字典 18708，校验通过。

备注：

- `npm run bench:browser-ocr-smoke -- --system-chrome` 在本机系统 Chrome 上等待 service worker 超时；使用 Playwright 自带 Chromium 可以通过。该失败不是 v6 推理错误。

## 最终产品收敛

- 评估阶段曾同时跑通 Paddle v5、PP-OCRv6 small 和 PP-OCRv6 medium，用于同条件速度与兼容性比较。
- 最终产品决策是插件侧只保留 `48px` 和 `Paddle` 两个 OCR 选项，其中 `Paddle` 写入并运行 `paddleocr_v6_medium`。
- 旧设置值 `paddleocr` 和 `paddleocr_v6_small` 仅作为兼容别名保留，归一化到 `paddleocr_v6_medium`，不再作为可见选项或独立 provider 注册。
- v6 small 的评估数据保留在本研究记录中作为历史依据；当前运行时和后续 smoke/debug 脚本按 medium-only 的产品形态维护。
