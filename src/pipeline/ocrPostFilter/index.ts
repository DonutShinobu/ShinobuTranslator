import type {
  OcrPostFilterDebugDecision,
  OcrPostFilterDebugInfo,
  QuadPoint,
  Rect,
  TextRegion,
} from "../../types";
import type {
  PipelineCanvas,
  PipelineImage,
  PlatformProvider,
} from "../../runtime/platform";
import {
  getOcrProvider,
  type OcrRecognizeOutput,
} from "../ocr/provider";
import type { ProviderExecutionReport } from "@shinobu/image-pipeline";
import {
  ProviderPostProcessingError,
  type ProviderSessionResolver,
} from "../../runtime/providerExecution";
import {
  evaluateOcrPostFilterCandidate,
  OCR_POST_FILTER_RULE_ID,
  type OcrPostFilterMaskFeatures,
  type OcrPostFilterVariant,
} from "./rule";

const MAX_MASK_SAMPLE_SIDE = 320;
const OCR_VARIANTS = [
  { name: "inset", scale: 0.94 },
  { name: "original", scale: 1 },
  { name: "outset", scale: 1.06 },
] as const;

export type OcrPostFilterOptions = {
  platform: PlatformProvider;
  providerName: string;
  resolver?: ProviderSessionResolver;
  recognize?(
    image: PipelineImage,
    regions: TextRegion[],
    platform: PlatformProvider,
  ): Promise<OcrRecognizeOutput>;
};

export type OcrPostFilterResult = {
  regions: TextRegion[];
  debug: OcrPostFilterDebugInfo;
  providerReports: ProviderExecutionReport[];
};

type VariantMetadata = {
  sourceRegion: TextRegion;
  name: string;
  variantRegion: TextRegion;
};

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, "");
}

function countGraphemes(text: string): number {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text),
    ).length;
  }
  return Array.from(text).length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function regionQuad(
  region: Pick<TextRegion, "box" | "quad">,
): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  return region.quad ?? [
    { x: region.box.x, y: region.box.y },
    { x: region.box.x + region.box.width, y: region.box.y },
    { x: region.box.x + region.box.width, y: region.box.y + region.box.height },
    { x: region.box.x, y: region.box.y + region.box.height },
  ];
}

function scaledQuad(
  region: TextRegion,
  scale: number,
  imageWidth: number,
  imageHeight: number,
): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  const quad = regionQuad(region);
  const centerX = quad.reduce((sum, point) => sum + point.x, 0) / quad.length;
  const centerY = quad.reduce((sum, point) => sum + point.y, 0) / quad.length;
  return quad.map((point) => ({
    x: clamp(
      centerX + (point.x - centerX) * scale,
      0,
      Math.max(0, imageWidth - 1),
    ),
    y: clamp(
      centerY + (point.y - centerY) * scale,
      0,
      Math.max(0, imageHeight - 1),
    ),
  })) as [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
}

function quadBox(
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
): Rect {
  const minX = Math.floor(Math.min(...quad.map((point) => point.x)));
  const minY = Math.floor(Math.min(...quad.map((point) => point.y)));
  const maxX = Math.ceil(Math.max(...quad.map((point) => point.x)));
  const maxY = Math.ceil(Math.max(...quad.map((point) => point.y)));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function isExpandedGateCandidate(
  region: TextRegion,
  imageWidth: number,
  imageHeight: number,
): boolean {
  const normalized = normalizeText(region.sourceText);
  const width = Math.max(1, region.box.width);
  const height = Math.max(1, region.box.height);
  return (
    Boolean(normalized)
    && region.bubbleBox === undefined
    && (region.originalLineCount ?? 1) <= 1
    && countGraphemes(normalized) <= 5
    && width * height / Math.max(1, imageWidth * imageHeight) >= 0.015
    && Math.max(width / height, height / width) <= 2.6
  );
}

function pointInPolygon(x: number, y: number, polygon: QuadPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (
      (a.y > y) !== (b.y > y)
      && x < (b.x - a.x) * (y - a.y) / (b.y - a.y || 1e-12) + a.x
    );
    if (crosses) inside = !inside;
  }
  return inside;
}

function connectedComponentAreas(
  binary: Uint8Array,
  width: number,
  height: number,
): number[] {
  const visited = new Uint8Array(binary.length);
  const queue = new Int32Array(binary.length);
  const areas: number[] = [];
  for (let start = 0; start < binary.length; start += 1) {
    if (binary[start] === 0 || visited[start] === 1) continue;
    let head = 0;
    let tail = 0;
    let componentArea = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      componentArea += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
            continue;
          }
          const next = nextY * width + nextX;
          if (binary[next] === 0 || visited[next] === 1) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    if (componentArea >= 2) areas.push(componentArea);
  }
  return areas;
}

function measureMask(
  rawMask: PipelineCanvas,
  region: TextRegion,
  platform: PlatformProvider,
): OcrPostFilterMaskFeatures {
  const boxX = Math.max(0, Math.floor(region.box.x));
  const boxY = Math.max(0, Math.floor(region.box.y));
  const boxWidth = Math.max(1, Math.min(
    rawMask.width - boxX,
    Math.ceil(region.box.width),
  ));
  const boxHeight = Math.max(1, Math.min(
    rawMask.height - boxY,
    Math.ceil(region.box.height),
  ));
  const sampleScale = Math.min(
    1,
    MAX_MASK_SAMPLE_SIDE / Math.max(boxWidth, boxHeight),
  );
  const sampleWidth = Math.max(1, Math.round(boxWidth * sampleScale));
  const sampleHeight = Math.max(1, Math.round(boxHeight * sampleScale));
  const sampleCanvas = platform.createCanvas(sampleWidth, sampleHeight);
  const context = sampleCanvas.getContext("2d");
  if (!context) {
    throw new Error("raw mask 2d context unavailable");
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(
    rawMask,
    boxX,
    boxY,
    boxWidth,
    boxHeight,
    0,
    0,
    sampleWidth,
    sampleHeight,
  );
  const rgba = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  const quad = regionQuad(region).map((point) => ({
    x: (point.x - boxX) / boxWidth * sampleWidth,
    y: (point.y - boxY) / boxHeight * sampleHeight,
  }));
  const binary = new Uint8Array(sampleWidth * sampleHeight);
  let quadSamplePixels = 0;
  let foregroundPixels = 0;
  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      if (!pointInPolygon(x + 0.5, y + 0.5, quad)) continue;
      quadSamplePixels += 1;
      const index = y * sampleWidth + x;
      if (rgba[index * 4] <= 127) continue;
      binary[index] = 1;
      foregroundPixels += 1;
    }
  }
  let boundaryPixels = 0;
  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const index = y * sampleWidth + x;
      if (binary[index] === 0) continue;
      if (
        x === 0
        || y === 0
        || x === sampleWidth - 1
        || y === sampleHeight - 1
        || binary[index - 1] === 0
        || binary[index + 1] === 0
        || binary[index - sampleWidth] === 0
        || binary[index + sampleWidth] === 0
      ) {
        boundaryPixels += 1;
      }
    }
  }
  const componentAreas = connectedComponentAreas(binary, sampleWidth, sampleHeight);
  return {
    maskFillRatioInQuad: foregroundPixels / Math.max(1, quadSamplePixels),
    componentCount: componentAreas.length,
    largestComponentRatio: Math.max(0, ...componentAreas)
      / Math.max(1, foregroundPixels),
    boundaryPixelRatio: boundaryPixels / Math.max(1, foregroundPixels),
  };
}

function buildVariantMetadata(
  candidates: TextRegion[],
  imageWidth: number,
  imageHeight: number,
): VariantMetadata[] {
  return candidates.flatMap((sourceRegion) => OCR_VARIANTS.map((variant) => {
    const quad = scaledQuad(
      sourceRegion,
      variant.scale,
      imageWidth,
      imageHeight,
    );
    return {
      sourceRegion,
      name: variant.name,
      variantRegion: {
        id: `${sourceRegion.id}::postfilter-${variant.name}-${variant.scale}`,
        box: quadBox(quad),
        quad,
        direction: sourceRegion.direction,
        sourceText: "",
        translatedText: "",
      },
    };
  }));
}

function variantsForRegion(
  region: TextRegion,
  metadata: VariantMetadata[],
  rawOcr: OcrRecognizeOutput,
): OcrPostFilterVariant[] {
  const debugByRegionId = new Map(
    (rawOcr.debug?.paddle?.regions ?? []).map((item) => [item.regionId, item]),
  );
  const acceptedByRegionId = new Map(
    rawOcr.results
      .filter((item) => item.regionId)
      .map((item) => [item.regionId!, item]),
  );
  return metadata
    .filter((item) => item.sourceRegion.id === region.id)
    .map((item) => {
      const debug = debugByRegionId.get(item.variantRegion.id);
      const accepted = acceptedByRegionId.get(item.variantRegion.id);
      return {
        name: item.name,
        text: debug?.decodedText ?? accepted?.text ?? "",
        confidence: debug?.confidence ?? accepted?.confidence ?? 0,
        accepted: debug?.accepted ?? Boolean(accepted),
      };
    });
}

function makeDebugDecision(
  region: TextRegion,
  relativeArea: number,
  aspectRatio: number,
  variants: OcrPostFilterVariant[],
  mask: OcrPostFilterMaskFeatures,
): OcrPostFilterDebugDecision {
  const evaluation = evaluateOcrPostFilterCandidate({
    sourceText: region.sourceText,
    probability: region.prob ?? 0,
    originalLineCount: region.originalLineCount ?? 1,
    hasBubble: region.bubbleBox !== undefined,
    relativeArea,
    aspectRatio,
    variants,
    mask,
  });
  return {
    regionId: region.id,
    sourceText: region.sourceText,
    relativeArea,
    aspectRatio,
    variants,
    mask,
    eligible: evaluation.eligible,
    shouldFilter: evaluation.shouldFilter,
    majorityAgreement: evaluation.majorityAgreement,
    variantScriptDrift: evaluation.variantScriptDrift,
    nonEmptyScriptDrift: evaluation.nonEmptyScriptDrift,
    originalVariantConfidence: evaluation.originalVariantConfidence,
    maskSignalCount: evaluation.maskSignalCount,
    junkLikeSource: evaluation.junkLikeSource,
    poorConsensus: evaluation.poorConsensus,
    protectionReason: evaluation.protectionReason,
  };
}

export async function filterOcrRegions(
  image: PipelineImage,
  rawMask: PipelineCanvas,
  regions: TextRegion[],
  options: OcrPostFilterOptions,
): Promise<OcrPostFilterResult> {
  const startedAt = performance.now();
  const imageWidth = image.naturalWidth;
  const imageHeight = image.naturalHeight;
  const candidates = regions.filter((region) => (
    isExpandedGateCandidate(region, imageWidth, imageHeight)
  ));
  if (candidates.length === 0) {
    return {
      regions,
      providerReports: [],
      debug: {
        mode: "balanced",
        ruleId: OCR_POST_FILTER_RULE_ID,
        candidateCount: 0,
        filteredCount: 0,
        filteredRegionIds: [],
        decisions: [],
        durationMs: performance.now() - startedAt,
        skippedReason: "no-candidates",
      },
    };
  }
  const metadata = buildVariantMetadata(candidates, imageWidth, imageHeight);
  const variantRegions = metadata.map((item) => item.variantRegion);
  let rawOcr: OcrRecognizeOutput;
  let providerReports: ProviderExecutionReport[] = [];
  if (options.recognize) {
    rawOcr = await options.recognize(
      image,
      variantRegions,
      options.platform,
    );
  } else {
    const provider = getOcrProvider(options.providerName);
    if (!provider) {
      throw new Error(`OCR 引擎未注册: ${options.providerName}`);
    }
    if (!options.resolver) {
      throw new Error("OCR 后处理需要 ProviderSessionResolver");
    }
    const execution = await options.resolver.execute({
      model: "paddleocr_v6_medium_rec",
      stage: "ocr",
      run: (session) =>
        provider.recognize(
          image,
          variantRegions,
          session,
          options.platform,
        ),
    });
    rawOcr = execution.value;
    providerReports = [execution.report];
  }
  try {
    const decisions = candidates.map((region) => {
      const width = Math.max(1, region.box.width);
      const height = Math.max(1, region.box.height);
      return makeDebugDecision(
        region,
        width * height / Math.max(1, imageWidth * imageHeight),
        Math.max(width / height, height / width),
        variantsForRegion(region, metadata, rawOcr),
        measureMask(rawMask, region, options.platform),
      );
    });
    const filteredRegionIds = decisions
      .filter((decision) => decision.shouldFilter)
      .map((decision) => decision.regionId);
    const filtered = new Set(filteredRegionIds);
    return {
      regions: regions.filter((region) => !filtered.has(region.id)),
      providerReports,
      debug: {
        mode: "balanced",
        ruleId: OCR_POST_FILTER_RULE_ID,
        candidateCount: candidates.length,
        filteredCount: filteredRegionIds.length,
        filteredRegionIds,
        decisions,
        durationMs: performance.now() - startedAt,
      },
    };
  } catch (error) {
    if (providerReports.length === 0) throw error;
    throw new ProviderPostProcessingError(error, providerReports);
  }
}
