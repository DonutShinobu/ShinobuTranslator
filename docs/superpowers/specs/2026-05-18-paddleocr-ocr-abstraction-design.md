# OCR 层抽象设计 — 支持 PaddleOCR 引擎

## 背景

当前 OCR 使用自研 ONNX AR Transformer 模型，硬编码无抽象层。需要引入 PaddleOCR 作为可选识别引擎，同时保持下游流程（排版、翻译）不变。

## 自研模型 vs PaddleOCR 输出差异

| 输出字段 | 自研模型 | PaddleOCR | 缺失影响 |
|----------|----------|-----------|----------|
| text | 有 | 有 | 无 |
| confidence | 有 | 有 | 无 |
| quad (边界框) | 有 | 有 | 无 |
| direction (h/v) | 有 | 无 | 排版依赖竖排方向 |
| fgColor/bgColor | 有 | 无 | 排版渲染依赖文字颜色 |
| tokenIds | 有 | 无 | 仅内部用，无影响 |

## 方案：统一接口 + 可选颜色扩展

OcrProvider 接口有必选和可选字段。自研模型返回完整字段，PaddleOCR 只返回必选字段，公共层自动补全缺失字段。

### 接口定义

```typescript
export type OcrRecognizeResult = {
  // 必选 — 所有引擎必须返回
  text: string;
  confidence: number;
  quad: Quad;

  // 可选 — 有能力的引擎返回，否则公共层补全
  direction?: Direction;  // "h" | "v"
  fgColor?: RGB;
  bgColor?: RGB;
};

export type OcrProvider = {
  name: string;
  recognize(image: ImageData, regions: TextRegion[]): Promise<OcrRecognizeResult[]>;
};
```

### 缺失字段补全

`fillMissingOcrFields(image, results)` 对每个 result 检查缺失字段并补全：

**方向补全：**
- quad 宽 ≥ 高 → "h"，高 > 宽 → "v"
- 复用现有 `generateTextDirection` 逻辑

**颜色补全 — 边缘检测采样：**
- fgColor：quad 区域内做边缘检测（Sobel 滤波），取梯度大的像素颜色均值
- bgColor：quad 区域四角像素颜色均值（角落通常是纯背景）
- 边缘检测在裁剪后的小区域上做（几百像素宽），开销小
- 需过滤低梯度噪点，只取梯度足够大的像素

**补全时机：** `runOcr` 返回后、交付下游之前。

下游消费时，direction、fgColor、bgColor 一定存在（补全后保证），无需处理缺失情况。

### 引擎注册与切换

```typescript
const ocrProviders: Record<string, OcrProvider> = {};

function registerOcrProvider(provider: OcrProvider) {
  ocrProviders[provider.name] = provider;
}

async function runOcr(image, regions, providerName?: string): Promise<OcrResult> {
  const provider = ocrProviders[providerName ?? defaultProviderName];
  const rawResults = await provider.recognize(image, regions);
  const results = fillMissingOcrFields(image, rawResults);
  // ...
}
```

设置页面用两个单选按钮切换引擎：内置模型 / PaddleOCR。所有引擎代码打包时一起编译，运行时选择调用哪个。

### PaddleOCR 引擎实现

**方式：本地 ONNX 推理**

**使用模型：PP-OCRv5_server_rec（识别）**

| 属性 | 值 |
|------|------|
| 模型名 | PP-OCRv5_server_rec |
| 大小 | ~84MB ONNX |
| 日文精度 | 73.72% |
| 竖排文字 | 支持 |
| 多语言 | 中文简繁、英文、日文统一模型 |
| ONNX 导出 | 已有现成导出（MeKo-Christian/paddleocr-onnx） |

备选：PP-OCRv5_mobile_rec（16MB，日文精度约54.65%），可在设置中作为轻量选项。

- 模型导出来源：https://github.com/MeKo-Christian/paddleocr-onnx（PP-OCRv5 全系列已导出为 ONNX）
- 用 `onnxruntime-web` 在 Web Worker 中本地运行，和自研模型架构一致
- 只做识别，检测层保持不变（继续用当前 detect 模块）
- 方向分类模型（PP-LCNet_x0_25_textline_ori）不使用 — 方向由 quad 宽高比推断

**PaddleOCR 引擎不做的事：**
- 不做检测（由现有 detect 模块负责）
- 不做方向推断（由补全逻辑负责）
- 不做颜色提取（由补全逻辑负责）

### 数据流

**PaddleOCR 模式：**
1. detect（不变）→ TextRegion[]
2. PaddleOCR.recognize → OcrRecognizeResult[]（text, confidence, quad）
3. fillMissingOcrFields → 补全 direction、fgColor、bgColor
4. 合成完整 TextRegion[]
5. 后续不变（merge → translate → typeset）

**内置模型模式：**
1. detect（不变）→ TextRegion[]
2. builtin.recognize → OcrRecognizeResult[]（全部字段）
3. fillMissingOcrFields → 无缺失，直接通过
4. 合成完整 TextRegion[]
5. 后续不变

两个引擎走同一个 `runOcr` 入口和同一个补全步骤，下游代码完全不变。

## PaddleOCR 方向能力补充说明

PaddleOCR 的文字行方向分类模块只有 2 类（0°/180°），不支持 90°/270° 竖排判断。PP-OCRv5_rec 声称支持竖排文字识别，但不输出方向。PaddleOCR-VL for Manga 能识别漫画竖排文字但只输出纯文本，无边界框或方向。

因此方向补全依赖 quad 宽高比推断，这是可靠的替代方案。