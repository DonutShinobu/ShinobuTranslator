"""
修改 PP-OCRv5_server_rec.onnx 中 MaxPool 的 ceil_mode 从 1 改为 0，
使其兼容 onnxruntime-web（WebGPU/WASM 后端不支持 ceil_mode）。

用法: python scripts/fix_paddleocr_maxpool_ceil.py
"""
import onnx

model_path = "public/models/paddleocr_v5_server_rec.onnx"
output_path = model_path  # 直接修改原文件

model = onnx.load(model_path)

changed = 0
for node in model.graph.node:
    if node.op_type == "MaxPool":
        for attr in node.attribute:
            if attr.name == "ceil_mode" and attr.i == 1:
                attr.i = 0
                changed += 1
                print(f"  修改节点 {node.name}: ceil_mode 1 -> 0")

if changed == 0:
    print("未找到 ceil_mode=1 的 MaxPool 节点")
else:
    print(f"共修改 {changed} 个 MaxPool 节点")
    onnx.save(model, output_path)
    print(f"已保存到 {output_path}")