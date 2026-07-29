# 气泡检测设计方案

## 目标

解决翻译后文字比原文多时字体过小的问题。通过检测漫画气泡边界，让排版使用气泡内部空间而非文字 bounding box，使字体大小尽可能接近原文。

## 模型

**kitsumed/yolov8m_seg-speech-bubble** — YOLOv8m-seg 微调的气泡实例分割模型。

- 格式：ONNX（动态轴）
- 体积：~52MB
- 输入：`[1, 3, 640, 640]` float32，归一化 [0,1]，letterbox 填充
- 输出：
  - `output0`: `[1, 37, N]` — 4(cx,cy,w,h) + 1(置信度) + 32(mask 系数)
  - `output1`: `[1, 32, 160, 160]` — proto masks

## 后处理

1. 转置 output0 为 `[N, 37]`
2. 提取 box、置信度、32 个 mask 系数
3. 置信度阈值 0.5 过滤
4. NMS（IoU 0.5）
5. mask 系数 × proto masks → sigmoid → 裁剪到 box → 缩放回原图尺寸

## Pipeline 集成

在 detect 之后、OCR 之前插入：

```
detect → bubbleDetect → OCR → merge → translate/erase → typeset
```

### 新增文件

- `src/pipeline/bubbleDetect.ts` — 预处理、推理、NMS、mask 解码、region 匹配

### 改动文件

- `src/runtime/modelRegistry.ts` — manifest 新增 `"bubble"` 模型条目
- `src/pipeline/orchestrator.ts` — detect 后调用 bubbleDetect + matchRegionsToBubbles
- `src/types.ts`（或类型定义处）— TextRegion 新增 `bubbleBox?: Rect` 和 `bubbleMask?` 字段
- `src/pipeline/typesetGeometry.ts` — `expandRegionBeforeRender` 中，有 bubbleBox 时用其替换 region box

## 文字 region ↔ 气泡匹配

1. 计算文字 region 中心点
2. 遍历所有气泡，检查中心点是否在气泡 mask 内（像素级）
3. 多个气泡包含该中心点时，选面积最小的
4. 无匹配 → 该 region 不设 bubbleBox，排版走现有逻辑；在日志中记录该 region 未匹配气泡，日志可视化中也要有对应反馈（如高亮未匹配的 region）

## 排版改动

当 region 有 `bubbleBox` 时：
- 在 `expandRegionBeforeRender` 之前，将 region 的 box 替换为 bubbleBox
- `resolveInitialFontSize` 仍用原始 `region.fontSize`，不因空间变大而放大字体
- 排版内部逻辑不变，自然获得更大空间

## 错误处理

- 模型加载失败 → 报错，中断流程
- 推理失败 → 报错，中断流程
- 某个 region 无匹配气泡 → 回退到现有逻辑，日志和日志可视化中反馈未匹配信息

