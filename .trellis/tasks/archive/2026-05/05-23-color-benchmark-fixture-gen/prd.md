# 改进颜色 benchmark fixture 生成方式

## Goal

利用网页端的日志导出功能，半自动生成颜色 benchmark fixture。用户只需导出调试日志 JSON，脚本自动提取 bbox + OCR 原文 + pipeline 颜色，用户只填有问题区域的前景/背景 hex 颜色。

## Requirements

1. **修改日志导出**：给 `OcrRegionLogItem` 加上 `fgColor`/`bgColor` 字段，导出时带上 pipeline 提取的颜色
2. **标注模板生成脚本**：读日志 JSON → 提取图片(data URL → PNG) + 所有区域信息 → 生成用户标注模板
   - 每个区域包含：regionId, sourceText, bbox, pipelineFg(hex), pipelineBg(hex), expectedFg(null), expectedBg(null)
   - 用户用 hex 格式 `"#191a1b"` 填 expectedFg/expectedBg，null 表示该区域没问题（跳过）
   - 图片自动从 sourceImageUrl 的 data URL 解码保存为 PNG
3. **Fixture 生成脚本**：读标注模板 → 转换为 ColorFixture 格式 → 写入 fixtures 目录
   - null 区域直接丢弃（没问题的不需要测试）
   - hex → RGB 自动转换

## Acceptance Criteria

* [ ] OcrRegionLogItem 包含 fgColor/bgColor，日志导出正常工作
* [ ] 标注模板生成脚本可用：输入日志 JSON → 输出标注模板 JSON + PNG 图片
* [ ] Fixture 生成脚本可用：输入标注模板 → 输出 ColorFixture JSON
* [ ] 生成的 fixture 能被现有 color-diagnostic.ts / color-comparison.ts 正常加载和使用
* [ ] 用户操作流程：导出日志 → 填颜色 → 生成 fixture，全程不需要手动测量像素坐标

## Definition of Done

* Lint / typecheck green
* 手动验证完整流程（导出日志 → 填颜色 → 生成 fixture → 跑 benchmark）

## Decision (ADR-lite)

**Context**: 手动填 bbox 太繁琐，但真实漫画场景测试不可省略
**Decision**: 从日志导出中提取 bbox 和 sourceText，用户只填 hex 颜色。null = 跳过。
**Consequences**: fixture 覆盖范围取决于用户在网页上实际遇到的问题场景，可能不全面但覆盖了真实痛点

## Out of Scope

* 合成图片自动生成 fixture（方案 A，未来可补充）
* Pipeline 自动检测 + 全自动颜色提取（方案 B 全自动版，需要运行 pipeline）

## Implementation Plan

### Step 1: 修改日志导出（src 端）

- `src/content/core/types.ts`: 给 `OcrRegionLogItem` 加 `fgColor?: [number, number, number]` + `bgColor?: [number, number, number]`
- `src/content/core/TranslatorCore.ts`: `toTypesetDebugDownloadData()` 中从 `detectedRegions` 取 `fgColor`/`bgColor` 写入 `OcrRegionLogItem`
- 编译插件 → 用户导出日志确认新字段存在

### Step 2: 标注模板生成脚本

- 新建 `benchmark/color/src/gen-annotation.ts`
- 输入：debug log JSON 文件路径（命令行参数）
- 输出：
  - fixtures 目录下保存 PNG 图片（从 sourceImageUrl data URL 解码）
  - fixtures 目录下保存 `*-annotation.json` 标注模板
- 标注模板格式：
```json
{
  "imageFile": "xxx.png",
  "regions": [
    {
      "regionId": "r-0",
      "sourceText": "こんにちは",
      "bbox": [10, 20, 150, 40],
      "pipelineFg": "#3c3c3c",
      "pipelineBg": "#ffffff",
      "expectedFg": null,
      "expectedBg": null
    }
  ]
}
```

### Step 3: Fixture 生成脚本

- 新建 `benchmark/color/src/gen-fixture.ts`
- 输入：标注模板 JSON 文件路径（命令行参数）
- 处理：过滤 null 区域，hex → RGB，输出 ColorFixture JSON
- 输出：fixtures 目录下 `*-fixture.json`

### Step 4: 清理旧 fixture

- 删除现有的 5 个手工 fixture JSON（没有对应图片，无法实际运行 benchmark）
- 通过新流程重新创建有图片的真实 fixture

## Technical Notes

* 现有 fixture 目录：benchmark/color/fixtures/
* 当前 5 个 fixture JSON 引用的 PNG 图片不存在，benchmark 脚本会跳过
* 日志导出格式：TypesetDebugDownloadData → ocrRegions (需加 fgColor/bgColor)
* OcrRegionLogItem 当前字段：regionId, direction, box, quad, sourceText
* TextRegion 有 fgColor/bgColor 但没导出到日志
* 图片保存：从 sourceImageUrl 的 data URL 解码 → PNG（脚本自动完成）
* Fixture bbox 格式：[x, y, w, h]（从 Rect {x, y, width, height} 转换）
* 脚本语言：Node.js（与现有 benchmark 脚本一致）