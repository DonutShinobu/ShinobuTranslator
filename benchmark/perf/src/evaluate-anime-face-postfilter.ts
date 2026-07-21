import { createCanvas, loadImage } from "canvas";
import * as ort from "onnxruntime-node";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_ANALYSIS_DIR = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-face-misdetection-analysis-v1-20260721",
);
const DEFAULT_RESULTS_DIR = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-project-pipeline-batch-v1-20260721",
);
const DEFAULT_IMAGES_DIR = join(
  ROOT,
  "benchmark",
  "images",
  "danbooru-translated-comic-4000",
);
const MODEL_SIZE = 640;
const MIN_FACE_SCORE = 0.05;
const NMS_IOU_THRESHOLD = 0.7;

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ReviewLabel =
  | "face_expression"
  | "broad_character_or_panel"
  | "face_text_mixed"
  | "non_face_art"
  | "actual_text";

type ReviewedCandidate = {
  id: string;
  input: string;
  imagePath: string;
  sourceText: string;
  normalizedText: string;
  graphemeCount: number;
  probability: number;
  box: Rect;
  bubbleBox?: Rect;
  imageWidth: number;
  imageHeight: number;
  relativeArea: number;
  aspectRatio: number;
  originalLineCount: number;
  reviewIndex: number;
  reviewLabel: ReviewLabel;
};

type Candidate = Omit<ReviewedCandidate, "reviewIndex" | "reviewLabel"> & {
  reviewIndex?: number;
  reviewLabel?: ReviewLabel;
};

type PipelineRegion = {
  id: string;
  box: Rect;
  prob?: number;
  originalLineCount?: number;
  sourceText: string;
  bubbleBox?: Rect;
};

type PipelineResult = {
  input: string;
  imageWidth: number;
  imageHeight: number;
  stageRegions: {
    ordered: PipelineRegion[];
  };
};

type Detection = Rect & {
  score: number;
};

type OverlapFeatures = {
  faceCount: number;
  maxFaceScore: number;
  maxIntersectionOverRegion: number;
  maxIntersectionOverFace: number;
  maxIntersectionOverMinArea: number;
  maxIou: number;
  regionCenterInsideFace: boolean;
  faceCenterInsideRegion: boolean;
};

type EvaluatedCandidate = Candidate & {
  faceFeatures: OverlapFeatures;
};

type TextMode = "ascii_shape" | "latin_or_digit" | "any";
type CenterMode = "none" | "region_center_inside_face" | "face_center_inside_region";

type Rule = {
  textMode: TextMode;
  maximumGraphemes: number;
  minimumRelativeArea: number;
  maximumAspectRatio: number;
  maximumProbability: number;
  minimumFaceScore: number;
  minimumIntersectionOverRegion: number;
  centerMode: CenterMode;
};

type RuleScore = Rule & {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
};

type CrossValidationFold = {
  fold: number;
  trainingImages: number;
  testImages: number;
  selectedRule: RuleScore;
  testScore: RuleScore;
};

type SupplementalReview = {
  id: string;
  reviewLabel: ReviewLabel;
  note: string;
};

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function collectJsonFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (
        entry.isFile()
        && entry.name.endsWith(".json")
        && entry.name !== "batch-summary.json"
      ) {
        files.push(path);
      }
    }
  };
  await walk(rootDir);
  return files.sort();
}

function countGraphemes(text: string): number {
  return Array.from(
    new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text),
  ).length;
}

async function collectPipelineGateCandidates(
  resultsDir: string,
  imagesDir: string,
): Promise<{ candidates: Candidate[]; orderedRegionCount: number }> {
  const resultPaths = await collectJsonFiles(resultsDir);
  const candidates: Candidate[] = [];
  let orderedRegionCount = 0;
  for (const resultPath of resultPaths) {
    const result = JSON.parse(
      await readFile(resultPath, "utf8"),
    ) as PipelineResult;
    orderedRegionCount += result.stageRegions.ordered.length;
    for (const region of result.stageRegions.ordered) {
      const normalizedText = region.sourceText.normalize("NFKC").replace(/\s+/g, "").trim();
      const graphemeCount = countGraphemes(normalizedText);
      const originalLineCount = region.originalLineCount ?? 1;
      const width = Math.max(1, region.box.width);
      const height = Math.max(1, region.box.height);
      const relativeArea = width * height / Math.max(
        1,
        result.imageWidth * result.imageHeight,
      );
      const aspectRatio = Math.max(width / height, height / width);
      if (
        !normalizedText
        || region.bubbleBox !== undefined
        || originalLineCount > 1
        || graphemeCount > 4
        || relativeArea < 0.015
        || aspectRatio > 1.6
      ) {
        continue;
      }
      candidates.push({
        id: `${result.input}#${region.id}`,
        input: result.input,
        imagePath: join(imagesDir, result.input),
        sourceText: region.sourceText,
        normalizedText,
        graphemeCount,
        probability: region.prob ?? 1,
        box: region.box,
        imageWidth: result.imageWidth,
        imageHeight: result.imageHeight,
        relativeArea,
        aspectRatio,
        originalLineCount,
      });
    }
  }
  return { candidates, orderedRegionCount };
}

function area(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersection(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function iou(a: Rect, b: Rect): number {
  const overlap = intersection(a, b);
  const union = area(a) + area(b) - overlap;
  return union > 0 ? overlap / union : 0;
}

function containsPoint(rect: Rect, x: number, y: number): boolean {
  return (
    x >= rect.x
    && y >= rect.y
    && x <= rect.x + rect.width
    && y <= rect.y + rect.height
  );
}

function nms(detections: Detection[]): Detection[] {
  const pending = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  while (pending.length > 0) {
    const best = pending.shift()!;
    kept.push(best);
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (iou(best, pending[index]) > NMS_IOU_THRESHOLD) pending.splice(index, 1);
    }
  }
  return kept;
}

async function detectFaces(
  session: ort.InferenceSession,
  imagePath: string,
): Promise<{ width: number; height: number; detections: Detection[] }> {
  const image = await loadImage(imagePath);
  const canvas = createCanvas(MODEL_SIZE, MODEL_SIZE);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, MODEL_SIZE, MODEL_SIZE);
  const rgba = context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const planeSize = MODEL_SIZE * MODEL_SIZE;
  const input = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    input[pixel] = rgba[pixel * 4] / 255;
    input[planeSize + pixel] = rgba[pixel * 4 + 1] / 255;
    input[planeSize * 2 + pixel] = rgba[pixel * 4 + 2] / 255;
  }
  const result = await session.run({
    images: new ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]),
  });
  const output = result.output0;
  if (output.dims.length !== 3 || output.dims[1] !== 5) {
    throw new Error(`Unexpected anime face model output: ${output.dims.join("x")}`);
  }
  const anchors = output.dims[2];
  const values = output.data as Float32Array;
  const detections: Detection[] = [];
  for (let index = 0; index < anchors; index += 1) {
    const score = values[anchors * 4 + index];
    if (score < MIN_FACE_SCORE) continue;
    const centerX = values[index];
    const centerY = values[anchors + index];
    const width = values[anchors * 2 + index];
    const height = values[anchors * 3 + index];
    detections.push({
      x: (centerX - width / 2) / MODEL_SIZE * image.width,
      y: (centerY - height / 2) / MODEL_SIZE * image.height,
      width: width / MODEL_SIZE * image.width,
      height: height / MODEL_SIZE * image.height,
      score,
    });
  }
  return { width: image.width, height: image.height, detections: nms(detections) };
}

function overlapFeatures(region: Rect, faces: Detection[]): OverlapFeatures {
  let maxFaceScore = 0;
  let maxIntersectionOverRegion = 0;
  let maxIntersectionOverFace = 0;
  let maxIntersectionOverMinArea = 0;
  let maxIou = 0;
  let regionCenterInsideFace = false;
  let faceCenterInsideRegion = false;
  const regionArea = Math.max(1, area(region));
  const regionCenterX = region.x + region.width / 2;
  const regionCenterY = region.y + region.height / 2;
  for (const face of faces) {
    const overlap = intersection(region, face);
    const faceArea = Math.max(1, area(face));
    if (overlap <= 0) continue;
    maxFaceScore = Math.max(maxFaceScore, face.score);
    maxIntersectionOverRegion = Math.max(maxIntersectionOverRegion, overlap / regionArea);
    maxIntersectionOverFace = Math.max(maxIntersectionOverFace, overlap / faceArea);
    maxIntersectionOverMinArea = Math.max(
      maxIntersectionOverMinArea,
      overlap / Math.min(regionArea, faceArea),
    );
    maxIou = Math.max(maxIou, iou(region, face));
    regionCenterInsideFace ||= containsPoint(face, regionCenterX, regionCenterY);
    faceCenterInsideRegion ||= containsPoint(
      region,
      face.x + face.width / 2,
      face.y + face.height / 2,
    );
  }
  return {
    faceCount: faces.length,
    maxFaceScore,
    maxIntersectionOverRegion,
    maxIntersectionOverFace,
    maxIntersectionOverMinArea,
    maxIou,
    regionCenterInsideFace,
    faceCenterInsideRegion,
  };
}

function matchesTextMode(candidate: EvaluatedCandidate, mode: TextMode): boolean {
  if (mode === "any") return true;
  if (mode === "ascii_shape") {
    return /^[A-Za-z0-9|IlOo]+$/.test(candidate.normalizedText);
  }
  return (
    /[A-Za-z0-9]/.test(candidate.normalizedText)
    && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
      candidate.normalizedText,
    )
  );
}

function matchesRule(candidate: EvaluatedCandidate, rule: Rule): boolean {
  const centerMatches = (
    rule.centerMode === "none"
    || (
      rule.centerMode === "region_center_inside_face"
      && candidate.faceFeatures.regionCenterInsideFace
    )
    || (
      rule.centerMode === "face_center_inside_region"
      && candidate.faceFeatures.faceCenterInsideRegion
    )
  );
  return (
    candidate.bubbleBox === undefined
    && candidate.originalLineCount <= 1
    && matchesTextMode(candidate, rule.textMode)
    && candidate.graphemeCount <= rule.maximumGraphemes
    && candidate.relativeArea >= rule.minimumRelativeArea
    && candidate.aspectRatio <= rule.maximumAspectRatio
    && candidate.probability < rule.maximumProbability
    && candidate.faceFeatures.maxFaceScore >= rule.minimumFaceScore
    && (
      candidate.faceFeatures.maxIntersectionOverRegion
      >= rule.minimumIntersectionOverRegion
    )
    && centerMatches
  );
}

function scoreRule(
  candidates: EvaluatedCandidate[],
  rule: Rule,
  positiveLabels: Set<ReviewLabel>,
  negativeLabels: Set<ReviewLabel>,
): RuleScore {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const candidate of candidates) {
    if (!candidate.reviewLabel) continue;
    const isPositive = positiveLabels.has(candidate.reviewLabel);
    const isNegative = negativeLabels.has(candidate.reviewLabel);
    if (!isPositive && !isNegative) continue;
    const predicted = matchesRule(candidate, rule);
    if (isPositive && predicted) truePositive += 1;
    else if (isPositive) falseNegative += 1;
    else if (predicted) falsePositive += 1;
    else trueNegative += 1;
  }
  return {
    ...rule,
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision: truePositive + falsePositive > 0
      ? truePositive / (truePositive + falsePositive)
      : 0,
    recall: truePositive + falseNegative > 0
      ? truePositive / (truePositive + falseNegative)
      : 0,
    falsePositiveRate: falsePositive + trueNegative > 0
      ? falsePositive / (falsePositive + trueNegative)
      : 0,
  };
}

function searchRules(
  candidates: EvaluatedCandidate[],
  positiveLabels: Set<ReviewLabel>,
  negativeLabels: Set<ReviewLabel>,
): RuleScore[] {
  const scores: RuleScore[] = [];
  for (const textMode of ["ascii_shape", "latin_or_digit", "any"] as const) {
    for (const maximumGraphemes of [1, 2, 3, 4]) {
      for (const minimumRelativeArea of [0.015, 0.03, 0.06, 0.1]) {
        for (const maximumAspectRatio of [1.4, 1.6, 2, 2.5, 3]) {
          for (const maximumProbability of [0.6, 0.8, 0.92, 1.01]) {
            for (const minimumFaceScore of [0.1, 0.2, 0.278, 0.4, 0.6]) {
              for (
                const minimumIntersectionOverRegion
                of [0.2, 0.35, 0.5, 0.525, 0.55, 0.65, 0.8]
              ) {
                for (
                  const centerMode
                  of [
                    "none",
                    "region_center_inside_face",
                    "face_center_inside_region",
                  ] as const
                ) {
                  scores.push(scoreRule(candidates, {
                    textMode,
                    maximumGraphemes,
                    minimumRelativeArea,
                    maximumAspectRatio,
                    maximumProbability,
                    minimumFaceScore,
                    minimumIntersectionOverRegion,
                    centerMode,
                  }, positiveLabels, negativeLabels));
                }
              }
            }
          }
        }
      }
    }
  }
  return scores.sort((a, b) => (
    a.falsePositive - b.falsePositive
    || b.truePositive - a.truePositive
    || b.precision - a.precision
  ));
}

function stableFold(input: string, foldCount: number): number {
  let hash = 2166136261;
  for (const character of input) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % foldCount;
}

function aggregateScores(scores: RuleScore[]): Omit<RuleScore, keyof Rule> {
  const truePositive = scores.reduce((sum, score) => sum + score.truePositive, 0);
  const falsePositive = scores.reduce((sum, score) => sum + score.falsePositive, 0);
  const falseNegative = scores.reduce((sum, score) => sum + score.falseNegative, 0);
  const trueNegative = scores.reduce((sum, score) => sum + score.trueNegative, 0);
  return {
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision: truePositive + falsePositive > 0
      ? truePositive / (truePositive + falsePositive)
      : 0,
    recall: truePositive + falseNegative > 0
      ? truePositive / (truePositive + falseNegative)
      : 0,
    falsePositiveRate: falsePositive + trueNegative > 0
      ? falsePositive / (falsePositive + trueNegative)
      : 0,
  };
}

function groupedCrossValidation(
  candidates: EvaluatedCandidate[],
  positiveLabels: Set<ReviewLabel>,
  negativeLabels: Set<ReviewLabel>,
  foldCount = 5,
): {
  foldCount: number;
  folds: CrossValidationFold[];
  aggregateTestScore: Omit<RuleScore, keyof Rule>;
} {
  const folds: CrossValidationFold[] = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const training = candidates.filter(
      (candidate) => stableFold(candidate.input, foldCount) !== fold,
    );
    const test = candidates.filter(
      (candidate) => stableFold(candidate.input, foldCount) === fold,
    );
    const selectedRule = searchRules(training, positiveLabels, negativeLabels)
      .find((score) => score.falsePositive === 0);
    if (!selectedRule) {
      throw new Error(`No zero-training-false-positive rule for fold ${fold}`);
    }
    folds.push({
      fold,
      trainingImages: new Set(training.map((candidate) => candidate.input)).size,
      testImages: new Set(test.map((candidate) => candidate.input)).size,
      selectedRule,
      testScore: scoreRule(test, selectedRule, positiveLabels, negativeLabels),
    });
  }
  return {
    foldCount,
    folds,
    aggregateTestScore: aggregateScores(folds.map((fold) => fold.testScore)),
  };
}

function labelFaceDetectionSummary(
  candidates: EvaluatedCandidate[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (
    const label
    of [
      "face_expression",
      "broad_character_or_panel",
      "face_text_mixed",
      "non_face_art",
      "actual_text",
    ] as const
  ) {
    const rows = candidates.filter((candidate) => candidate.reviewLabel === label);
    output[label] = {
      count: rows.length,
      anyOverlappingFaceAtPoint278: rows.filter((candidate) => (
        candidate.faceFeatures.maxFaceScore >= 0.278
        && candidate.faceFeatures.maxIntersectionOverRegion > 0
      )).length,
      regionCoverageAtLeastPoint5: rows.filter((candidate) => (
        candidate.faceFeatures.maxFaceScore >= 0.278
        && candidate.faceFeatures.maxIntersectionOverRegion >= 0.5
      )).length,
      regionCenterInsideFace: rows.filter((candidate) => (
        candidate.faceFeatures.maxFaceScore >= 0.278
        && candidate.faceFeatures.regionCenterInsideFace
      )).length,
    };
  }
  return output;
}

async function main(): Promise<void> {
  const analysisDir = resolve(readOption("analysis") ?? DEFAULT_ANALYSIS_DIR);
  const resultsDir = resolve(readOption("results") ?? DEFAULT_RESULTS_DIR);
  const imagesDir = resolve(readOption("images") ?? DEFAULT_IMAGES_DIR);
  const modelPath = readOption("model");
  if (!modelPath) throw new Error("Pass --model <anime face ONNX path>");
  const reviewedCandidatesPath = join(analysisDir, "reviewed-priority-candidates.json");
  const reviewedCandidates = JSON.parse(
    await readFile(reviewedCandidatesPath, "utf8"),
  ) as ReviewedCandidate[];
  const {
    candidates: pipelineGateCandidates,
    orderedRegionCount,
  } = await collectPipelineGateCandidates(resultsDir, imagesDir);
  const supplementalReviews = JSON.parse(
    await readFile(
      join(analysisDir, "anime-face-postfilter-unreviewed-review.json"),
      "utf8",
    ),
  ) as SupplementalReview[];
  const pipelineCandidateById = new Map(
    pipelineGateCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const supplementalReviewedCandidates = supplementalReviews.map(
    (review, index): ReviewedCandidate => {
      const candidate = pipelineCandidateById.get(review.id);
      if (!candidate) {
        throw new Error(`Supplemental review candidate not found: ${review.id}`);
      }
      return {
        ...candidate,
        reviewIndex: reviewedCandidates.length + index + 1,
        reviewLabel: review.reviewLabel,
      };
    },
  );
  const allReviewedCandidates = [
    ...reviewedCandidates,
    ...supplementalReviewedCandidates,
  ];
  const reviewById = new Map(
    allReviewedCandidates.map((candidate) => [
      candidate.id,
      {
        reviewIndex: candidate.reviewIndex,
        reviewLabel: candidate.reviewLabel,
      },
    ]),
  );
  const candidates = pipelineGateCandidates.map((candidate) => ({
    ...candidate,
    ...reviewById.get(candidate.id),
  }));
  const session = await ort.InferenceSession.create(resolve(modelPath), {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
  const detectionsByImage = new Map<string, Detection[]>();
  const uniqueImages = [...new Map(
    [...candidates, ...allReviewedCandidates]
      .map((candidate) => [candidate.input, candidate.imagePath]),
  ).entries()];
  const startedAt = performance.now();
  for (let index = 0; index < uniqueImages.length; index += 1) {
    const [input, imagePath] = uniqueImages[index];
    const result = await detectFaces(session, imagePath);
    detectionsByImage.set(input, result.detections);
    if ((index + 1) % 20 === 0 || index + 1 === uniqueImages.length) {
      console.log(`[face-eval] ${index + 1}/${uniqueImages.length}`);
    }
  }
  const evaluatedAll: EvaluatedCandidate[] = candidates.map((candidate) => ({
    ...candidate,
    faceFeatures: overlapFeatures(
      candidate.box,
      detectionsByImage.get(candidate.input) ?? [],
    ),
  }));
  const evaluated: EvaluatedCandidate[] = allReviewedCandidates.map((candidate) => ({
    ...candidate,
    faceFeatures: overlapFeatures(
      candidate.box,
      detectionsByImage.get(candidate.input) ?? [],
    ),
  }));
  const facePositive = new Set<ReviewLabel>(["face_expression"]);
  const protectedNegative = new Set<ReviewLabel>(["actual_text", "face_text_mixed"]);
  const faceRules = searchRules(evaluated, facePositive, protectedNegative);
  const allArtPositive = new Set<ReviewLabel>([
    "face_expression",
    "broad_character_or_panel",
    "non_face_art",
  ]);
  const allArtRules = searchRules(evaluated, allArtPositive, protectedNegative);
  const bestZeroFalsePositive = faceRules.filter(
    (score) => score.falsePositive === 0,
  ).slice(0, 30);
  const bestAtMostOneFalsePositive = faceRules.filter(
    (score) => score.falsePositive <= 1,
  ).sort((a, b) => (
    b.truePositive - a.truePositive
    || a.falsePositive - b.falsePositive
  )).slice(0, 30);
  const candidateRule: Rule = {
    textMode: "any",
    maximumGraphemes: 4,
    minimumRelativeArea: 0.015,
    maximumAspectRatio: 1.6,
    maximumProbability: 1.01,
    minimumFaceScore: 0.278,
    minimumIntersectionOverRegion: 0.2,
    centerMode: "region_center_inside_face",
  };
  const hardFilterRule: Rule = {
    ...candidateRule,
    minimumIntersectionOverRegion: 0.55,
  };
  const candidateRuleScore = scoreRule(
    evaluated,
    candidateRule,
    facePositive,
    protectedNegative,
  );
  const hardFilterRuleScore = scoreRule(
    evaluated,
    hardFilterRule,
    facePositive,
    protectedNegative,
  );
  const flaggedCandidates = evaluatedAll.filter(
    (candidate) => matchesRule(candidate, candidateRule),
  );
  const hardFilteredCandidates = evaluatedAll.filter(
    (candidate) => matchesRule(candidate, hardFilterRule),
  );
  const flaggedReviewed = flaggedCandidates.filter(
    (candidate) => candidate.reviewLabel !== undefined,
  );
  const flaggedUnreviewed = flaggedCandidates.filter(
    (candidate) => candidate.reviewLabel === undefined,
  );
  const summary = {
    createdAt: new Date().toISOString(),
    modelPath: resolve(modelPath),
    model: {
      family: "deepghs/anime_face_detection",
      variant: "face_detect_v1.4_n",
      inputSize: MODEL_SIZE,
      minimumDecodedScore: MIN_FACE_SCORE,
      nmsIouThreshold: NMS_IOU_THRESHOLD,
    },
    elapsedMs: performance.now() - startedAt,
    resultsDir,
    imagesDir,
    orderedRegionCount,
    pipelineGateCandidates: evaluatedAll.length,
    initialReviewedCandidates: reviewedCandidates.length,
    supplementalReviewedCandidates: supplementalReviewedCandidates.length,
    reviewedCandidates: evaluated.length,
    uniqueImages: uniqueImages.length,
    labelFaceDetectionSummary: labelFaceDetectionSummary(evaluated),
    faceExpressionEvaluation: {
      positiveLabels: [...facePositive],
      protectedNegativeLabels: [...protectedNegative],
      bestZeroFalsePositive,
      bestAtMostOneFalsePositive,
      candidateRule: candidateRuleScore,
      hardFilterRule: hardFilterRuleScore,
      groupedFiveFoldCrossValidation: groupedCrossValidation(
        evaluated,
        facePositive,
        protectedNegative,
      ),
      candidateRuleFlaggedAllCandidates: {
        count: flaggedCandidates.length,
        reviewed: flaggedReviewed.length,
        unreviewed: flaggedUnreviewed.length,
        reviewedLabelCounts: Object.fromEntries(
          [...new Set(flaggedReviewed.map((candidate) => candidate.reviewLabel))]
            .map((label) => [
              label,
              flaggedReviewed.filter((candidate) => candidate.reviewLabel === label).length,
            ]),
        ),
      },
      hardFilterRuleFlaggedAllCandidates: {
        count: hardFilteredCandidates.length,
        labelCounts: Object.fromEntries(
          [...new Set(hardFilteredCandidates.map((candidate) => candidate.reviewLabel))]
            .map((label) => [
              label,
              hardFilteredCandidates.filter(
                (candidate) => candidate.reviewLabel === label,
              ).length,
            ]),
        ),
      },
    },
    allArtEvaluation: {
      positiveLabels: [...allArtPositive],
      protectedNegativeLabels: [...protectedNegative],
      bestZeroFalsePositive: allArtRules.filter(
        (score) => score.falsePositive === 0,
      ).slice(0, 30),
    },
  };
  await mkdir(analysisDir, { recursive: true });
  await Promise.all([
    writeFile(
      join(analysisDir, "anime-face-overlap-candidates.json"),
      JSON.stringify(evaluated, null, 2),
      "utf8",
    ),
    writeFile(
      join(analysisDir, "anime-face-overlap-all-candidates.json"),
      JSON.stringify(evaluatedAll, null, 2),
      "utf8",
    ),
    writeFile(
      join(analysisDir, "anime-face-postfilter-flagged.json"),
      JSON.stringify(flaggedCandidates, null, 2),
      "utf8",
    ),
    writeFile(
      join(analysisDir, "anime-face-postfilter-hard-filtered.json"),
      JSON.stringify(hardFilteredCandidates, null, 2),
      "utf8",
    ),
    writeFile(
      join(analysisDir, "anime-face-overlap-evaluation.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    ),
  ]);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
