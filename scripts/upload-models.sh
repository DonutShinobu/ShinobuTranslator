#!/usr/bin/bash
# 创建 GitHub Release 并上传模型文件
# 用法: ./scripts/upload-models.sh <版本tag> [版本标题]
# 示例: ./scripts/upload-models.sh v0.1.0 "初始版本"
#
# 上传的文件名不含目录前缀（如 detector.onnx）
# Release URL 格式: https://github.com/DonutShinobu/ShinobuTranslator/releases/download/{tag}/detector.onnx
# 与 vite 构建时 MODEL_RELEASE_TAG 替换的 manifest 路径一致

set -euo pipefail

REPO="DonutShinobu/ShinobuTranslator"
MODEL_DIR="public/models"
TAG="${1:?请指定版本tag，例如 v0.1.0}"
TITLE="${2:-$TAG}"

if ! command -v gh &>/dev/null; then
  echo "需要 gh CLI，请先安装: https://cli.github.com/"
  exit 1
fi

# 检查文件存在
for file in detector.onnx ocr.onnx lama_fp32.onnx bubble.onnx ocr_dict.txt; do
  if [ ! -f "$MODEL_DIR/$file" ]; then
    echo "缺少模型文件: $MODEL_DIR/$file"
    exit 1
  fi
done

echo "正在创建 Release $TAG ..."

if gh release view "$TAG" --repo "$REPO" &>/dev/null; then
  echo "Release $TAG 已存在，直接上传文件"
else
  gh release create "$TAG" --repo "$REPO" --title "$TITLE" --notes "ONNX 模型文件，用于浏览器端漫画翻译推理"
fi

echo "正在上传模型文件..."
gh release upload "$TAG" \
  "$MODEL_DIR/detector.onnx" \
  "$MODEL_DIR/ocr.onnx" \
  "$MODEL_DIR/lama_fp32.onnx" \
  "$MODEL_DIR/bubble.onnx" \
  "$MODEL_DIR/ocr_dict.txt" \
  --repo "$REPO" --clobber

echo "上传完成！"
echo "下载地址: https://github.com/$REPO/releases/tag/$TAG"
echo "模型 URL 示例: https://github.com/$REPO/releases/download/$TAG/detector.onnx"