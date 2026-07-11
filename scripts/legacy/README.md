# Legacy model conversion scripts

这里保留已经退出当前产品路径、但对追溯模型来源或重新生成历史实验模型仍有参考价值的转换脚本。

这些脚本具有以下共同约束：

- 不被 `package.json`、Vite、Release build 或 CI 调用。
- 不代表当前支持的模型，也不会把产物加入 `public/models/models.json`。
- 运行前必须自行准备上游仓库、checkpoint、Python/Node 依赖和输出目录。
- 当前唯一 OCR 产品路径是 `paddleocr_v6_medium_rec`；旧 AR/48px 和 Lama 仅用于历史研究。

## 文件

- `export_ocr_ar_to_onnx.py`：把旧 `ocr_ar_48px.ckpt` 导出为历史整图 AR ONNX 模型。
- `split-ocr-encoder-decoder.mjs`：把旧 AR ONNX 图拆成 encoder/decoder，供已移除的 split decode 实验使用。
- `patch_lama_webgpu.py`：修补旧 Lama ONNX 图的 WebGPU 兼容节点；当前产品使用 AOT inpaint。

如需恢复其中任何能力，必须先作为新的实验任务重新建立 benchmark、模型清单和独立边界；不要把旧 RPC 重新静态导入生产 Worker。
