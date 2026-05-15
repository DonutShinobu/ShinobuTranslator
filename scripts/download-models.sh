#!/usr/bin/bash
# 从 GitHub Release 下载 ONNX 模型文件到 public/models/
# 用法: ./scripts/download-models.sh [版本tag]
# 默认版本: latest（自动查找最新的 models-* Release）
#
# Release 里文件名不含目录前缀（如 detector.onnx，不是 models/detector.onnx）
# 但本地存放路径是 public/models/detector.onnx

set -euo pipefail

REPO="DonutShinobu/ShinobuTranslator"
DEST="public/models"
INPUT_TAG="${1:-latest}"

mkdir -p "$DEST"

# 解析 tag：latest 自动查找最新的 models-* Release，v0.1.0 自动加 models- 前缀
if [ "$INPUT_TAG" = "latest" ]; then
  TAG=$(gh release list --repo "$REPO" --json tagName --jq '.[] | select(.tagName | startswith("models-")) | .tagName' | head -1)
  if [ -z "$TAG" ]; then
    echo "无法找到 models-* Release，请手动指定版本"
    exit 1
  fi
else
  # 自动加 models- 前缀
  TAG="${INPUT_TAG#models-}"
  TAG="models-${TAG}"
fi

echo "正在从 GitHub Release ($TAG) 下载模型..."

BASE_URL="https://github.com/$REPO/releases/download/$TAG"

for file in detector.onnx ocr.onnx lama_fp32.onnx bubble.onnx ocr_dict.txt; do
  if [ -f "$DEST/$file" ]; then
    echo "  $file 已存在，跳过"
    continue
  fi
  echo "  下载 $file ..."
  curl -fSL -o "$DEST/$file" "$BASE_URL/$file" || { echo "  下载失败: $file"; exit 1; }
done

# manifest.json 使用本地相对路径版本（仓库里的），不从 Release 下载
if [ ! -f "$DEST/manifest.json" ]; then
  echo "  manifest.json 不在 Release 中，使用仓库本地版本"
fi

echo "模型下载完成，文件位于 $DEST/"
ls -lh "$DEST"
