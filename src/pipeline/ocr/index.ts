import type { OcrRunDebugInfo, TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import type { RuntimeProvider, WebNnDeviceType } from "../../runtime/onnxTypes";
import {
  registerOcrProvider,
  registerOcrProviderAlias,
  getOcrProvider,
  fillMissingOcrFields,
} from "./provider";
import type { OcrRecognizeResult } from "./provider";
import { paddleocrV6MediumProvider } from "./paddleocrProvider";

registerOcrProvider(paddleocrV6MediumProvider);
registerOcrProviderAlias("builtin", "paddleocr_v6_medium");
registerOcrProviderAlias("48px", "paddleocr_v6_medium");
registerOcrProviderAlias("paddleocr", "paddleocr_v6_medium");
registerOcrProviderAlias("paddleocr_v6_small", "paddleocr_v6_medium");

export type OcrResult = {
  regions: TextRegion[];
  actualProvider: RuntimeProvider;
  actualWebnnDeviceType?: WebNnDeviceType;
  debug: OcrRunDebugInfo;
};

type RunOcrOptions = {
  compactActiveBatch?: boolean;
};

function mapResultsToRegions(results: OcrRecognizeResult[], detectedRegions: TextRegion[]): TextRegion[] {
  return results.map((result, index) => ({
    id: detectedRegions[index]?.id ?? `ocr-${index}`,
    box: detectedRegions[index]?.box ?? { x: 0, y: 0, width: 0, height: 0 },
    quad: result.quad,
    direction: result.direction,
    prob: result.confidence,
    fgColor: result.fgColor,
    bgColor: result.bgColor,
    sourceText: result.text,
    translatedText: "",
  }));
}

function createDefaultDebug(resultCount: number): OcrRunDebugInfo {
  return {
    mode: "ctc",
    candidateCount: resultCount,
    preparedCount: resultCount,
    preprocessTotalMs: 0,
    preprocessPerRegionMs: [],
    chunkBatchSize: 0,
    chunks: [],
    colorDecodeMode: "none",
    colorBatchSize: 0,
    colorSessionRunCount: 0,
    colorSessionRunTotalMs: 0,
    colorTotalMs: 0,
    colorFallbackRegions: [],
    fallbackTriggerCount: 0,
    totalSessionRunCount: 0,
    totalSessionRunMs: 0,
  };
}

function addExternalColorFillDebug(
  debugInfo: OcrRunDebugInfo,
  results: OcrRecognizeResult[],
  detectedRegions: TextRegion[],
  durationMs: number
): OcrRunDebugInfo {
  const missingColorResults = results.filter((result) => result.fgColor === undefined || result.bgColor === undefined);
  debugInfo.colorBatchSize = results.length;
  debugInfo.colorTotalMs += durationMs;
  if (debugInfo.paddle) {
    debugInfo.paddle.colorFillMs = (debugInfo.paddle.colorFillMs ?? 0) + durationMs;
  }
  if (missingColorResults.length > 0) {
    debugInfo.colorDecodeMode = "fallback";
    debugInfo.colorFallbackRegions = missingColorResults.map((result, index) => ({
      regionId: detectedRegions[results.indexOf(result)]?.id ?? `ocr-${index}`,
      durationMs: 0,
      accepted: true,
      error: "模型未返回颜色，使用图像采样补齐",
    }));
  } else if (results.length > 0 && debugInfo.colorDecodeMode === "none") {
    debugInfo.colorDecodeMode = "reuse";
  }
  return debugInfo;
}

function normalizeOcrProviderName(providerName?: string): string {
  if (
    !providerName ||
    providerName === "builtin" ||
    providerName === "48px" ||
    providerName === "paddleocr" ||
    providerName === "paddleocr_v6_small"
  ) {
    return "paddleocr_v6_medium";
  }
  return providerName;
}

export async function runOcr(
  image: PipelineImage,
  detectedRegions: TextRegion[],
  providerName?: string,
  platform?: PlatformProvider,
  _options?: RunOcrOptions
): Promise<OcrResult> {
  if (!platform) {
    throw new Error("OCR 需要 PlatformProvider");
  }

  const providerNameResolved = normalizeOcrProviderName(providerName);
  const provider = getOcrProvider(providerNameResolved);
  if (!provider) throw new Error(`OCR 引擎未注册: ${providerNameResolved}`);

  const output = await provider.recognize(image, detectedRegions, platform);
  const colorFillT0 = performance.now();
  const filled = fillMissingOcrFields(output.results, image, platform);
  const colorFillMs = performance.now() - colorFillT0;
  const debug = addExternalColorFillDebug(
    output.debug ?? createDefaultDebug(output.results.length),
    output.results,
    detectedRegions,
    colorFillMs
  );
  const regions = mapResultsToRegions(filled, detectedRegions);
  if (regions.length > 0) {
    return {
      regions,
      actualProvider: output.provider,
      actualWebnnDeviceType: output.webnnDeviceType,
      debug,
    };
  }
  throw new Error("OCR 未返回有效识别结果");
}
