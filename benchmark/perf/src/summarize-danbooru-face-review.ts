import { createCanvas, loadImage } from "canvas";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_ANALYSIS_DIR = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-face-misdetection-analysis-v1-20260721",
);
const REVIEW_LABELS = [
  "face_expression",
  "broad_character_or_panel",
  "face_text_mixed",
  "non_face_art",
  "actual_text",
] as const;

const COLUMNS = 4;
const ROWS = 3;
const TILE_WIDTH = 420;
const TILE_HEIGHT = 360;
const LABEL_HEIGHT = 56;
const PAGE_SIZE = COLUMNS * ROWS;

type ReviewLabel = (typeof REVIEW_LABELS)[number];

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Candidate = {
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
  widthRatio: number;
  heightRatio: number;
  aspectRatio: number;
  originalLineCount: number;
  riskScore: number;
  riskSignals: string[];
  expressionTags: string[];
};

type ReviewFile = {
  schemaVersion: number;
  source: string;
  indexing: string;
  definitions: Record<ReviewLabel, string>;
  labels: Record<ReviewLabel, number[]>;
};

type ReviewedCandidate = Candidate & {
  reviewIndex: number;
  reviewLabel: ReviewLabel;
};

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function quantile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function numericSummary(values: number[]): Record<string, number | null> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? null,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    max: sorted.at(-1) ?? null,
    mean: sorted.length > 0
      ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
      : null,
  };
}

function distribution(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

function bucket(value: number, thresholds: Array<[number, string]>, fallback: string): string {
  return thresholds.find(([upperBound]) => value < upperBound)?.[1] ?? fallback;
}

function scriptBucket(text: string): string {
  const hasJapanese = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text);
  const hasLatin = /\p{Script=Latin}/u.test(text);
  const hasNumber = /\p{Number}/u.test(text);
  if (hasJapanese && (hasLatin || hasNumber)) return "mixed_japanese_latin_or_digit";
  if (hasJapanese) return "japanese_only";
  if (/^[A-Za-z0-9|IlOo]+$/.test(text)) return "ascii_letter_or_digit_shape";
  if (hasLatin || hasNumber) return "other_latin_or_digit";
  return "symbols_or_other";
}

function validateReview(candidates: Candidate[], review: ReviewFile): Map<number, ReviewLabel> {
  const labelsByIndex = new Map<number, ReviewLabel>();
  for (const label of REVIEW_LABELS) {
    const indices = review.labels[label];
    if (!Array.isArray(indices)) throw new Error(`Missing review label array: ${label}`);
    for (const reviewIndex of indices) {
      if (!Number.isInteger(reviewIndex) || reviewIndex < 1 || reviewIndex > candidates.length) {
        throw new Error(`Invalid ${label} review index: ${reviewIndex}`);
      }
      const prior = labelsByIndex.get(reviewIndex);
      if (prior) throw new Error(`Review index ${reviewIndex} appears in ${prior} and ${label}`);
      labelsByIndex.set(reviewIndex, label);
    }
  }
  if (labelsByIndex.size !== candidates.length) {
    const missing = candidates
      .map((_, index) => index + 1)
      .filter((reviewIndex) => !labelsByIndex.has(reviewIndex));
    throw new Error(`Review is not exhaustive; missing indices: ${missing.join(", ")}`);
  }
  return labelsByIndex;
}

function contextRect(candidate: Candidate): Rect {
  const { box, imageWidth, imageHeight } = candidate;
  const paddingX = Math.max(box.width * 0.45, imageWidth * 0.035);
  const paddingY = Math.max(box.height * 0.45, imageHeight * 0.035);
  const x = Math.max(0, box.x - paddingX);
  const y = Math.max(0, box.y - paddingY);
  const right = Math.min(imageWidth, box.x + box.width + paddingX);
  const bottom = Math.min(imageHeight, box.y + box.height + paddingY);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ");
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

async function renderContactSheets(
  candidates: ReviewedCandidate[],
  outputDir: string,
): Promise<string[]> {
  const sheetsDir = join(outputDir, "reviewed-face-contact-sheets");
  await mkdir(sheetsDir, { recursive: true });
  const paths: string[] = [];

  for (let page = 0; page * PAGE_SIZE < candidates.length; page += 1) {
    const pageCandidates = candidates.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const canvas = createCanvas(COLUMNS * TILE_WIDTH, ROWS * TILE_HEIGHT);
    const context = canvas.getContext("2d");
    context.fillStyle = "#101318";
    context.fillRect(0, 0, canvas.width, canvas.height);

    for (let index = 0; index < pageCandidates.length; index += 1) {
      const candidate = pageCandidates[index];
      const column = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);
      const tileX = column * TILE_WIDTH;
      const tileY = row * TILE_HEIGHT;
      const drawY = tileY + LABEL_HEIGHT;
      const drawHeight = TILE_HEIGHT - LABEL_HEIGHT;
      context.fillStyle = "#181d24";
      context.fillRect(tileX + 2, tileY + 2, TILE_WIDTH - 4, TILE_HEIGHT - 4);

      const image = await loadImage(candidate.imagePath);
      const crop = contextRect(candidate);
      const scale = Math.min(TILE_WIDTH / crop.width, drawHeight / crop.height);
      const renderedWidth = crop.width * scale;
      const renderedHeight = crop.height * scale;
      const offsetX = tileX + (TILE_WIDTH - renderedWidth) / 2;
      const offsetY = drawY + (drawHeight - renderedHeight) / 2;
      context.drawImage(
        image,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        offsetX,
        offsetY,
        renderedWidth,
        renderedHeight,
      );
      context.strokeStyle = "#ff334d";
      context.lineWidth = 4;
      context.strokeRect(
        offsetX + (candidate.box.x - crop.x) * scale,
        offsetY + (candidate.box.y - crop.y) * scale,
        candidate.box.width * scale,
        candidate.box.height * scale,
      );

      context.fillStyle = "#f5f7fa";
      context.font = "bold 16px Segoe UI";
      context.fillText(
        `review #${candidate.reviewIndex} · ${candidate.input}`,
        tileX + 10,
        tileY + 20,
        TILE_WIDTH - 20,
      );
      context.font = "14px Segoe UI";
      context.fillText(
        `OCR=${truncate(candidate.sourceText, 16)}  p=${candidate.probability.toFixed(3)}  area=${(candidate.relativeArea * 100).toFixed(1)}%`,
        tileX + 10,
        tileY + 42,
        TILE_WIDTH - 20,
      );
      context.strokeStyle = "#2d3642";
      context.lineWidth = 1;
      context.strokeRect(tileX + 1, tileY + 1, TILE_WIDTH - 2, TILE_HEIGHT - 2);
    }

    const fileName = `contact-sheet-${String(page + 1).padStart(3, "0")}.jpg`;
    const path = join(sheetsDir, fileName);
    await writeFile(path, canvas.toBuffer("image/jpeg", { quality: 0.9 }));
    paths.push(relative(outputDir, path).replaceAll("\\", "/"));
  }
  return paths;
}

function percentage(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function summarizeFaceCandidates(candidates: ReviewedCandidate[]): Record<string, unknown> {
  const tagCounts = distribution(candidates.flatMap((candidate) => candidate.expressionTags));
  const sourceTextCounts = distribution(candidates.map((candidate) => candidate.normalizedText));
  return {
    candidateCount: candidates.length,
    distinctImageCount: new Set(candidates.map((candidate) => candidate.input)).size,
    probability: numericSummary(candidates.map((candidate) => candidate.probability)),
    relativeArea: numericSummary(candidates.map((candidate) => candidate.relativeArea)),
    aspectRatio: numericSummary(candidates.map((candidate) => candidate.aspectRatio)),
    graphemeCount: numericSummary(candidates.map((candidate) => candidate.graphemeCount)),
    singleGrapheme: {
      count: candidates.filter((candidate) => candidate.graphemeCount === 1).length,
      ratio: percentage(
        candidates.filter((candidate) => candidate.graphemeCount === 1).length,
        candidates.length,
      ),
    },
    noBubbleMatch: {
      count: candidates.filter((candidate) => candidate.bubbleBox === undefined).length,
      ratio: percentage(
        candidates.filter((candidate) => candidate.bubbleBox === undefined).length,
        candidates.length,
      ),
    },
    nearSquareOrCompact: {
      count: candidates.filter((candidate) => candidate.aspectRatio <= 2).length,
      ratio: percentage(
        candidates.filter((candidate) => candidate.aspectRatio <= 2).length,
        candidates.length,
      ),
    },
    highConfidenceAtLeastPointEight: {
      count: candidates.filter((candidate) => candidate.probability >= 0.8).length,
      ratio: percentage(
        candidates.filter((candidate) => candidate.probability >= 0.8).length,
        candidates.length,
      ),
    },
    highConfidenceAtLeastPointNine: {
      count: candidates.filter((candidate) => candidate.probability >= 0.9).length,
      ratio: percentage(
        candidates.filter((candidate) => candidate.probability >= 0.9).length,
        candidates.length,
      ),
    },
    confidenceBands: distribution(candidates.map((candidate) => bucket(
      candidate.probability,
      [
        [0.45, "below_0.45"],
        [0.6, "0.45_to_0.60"],
        [0.75, "0.60_to_0.75"],
        [0.9, "0.75_to_0.90"],
      ],
      "at_least_0.90",
    ))),
    areaBands: distribution(candidates.map((candidate) => bucket(
      candidate.relativeArea,
      [
        [0.03, "1.5_to_3_percent"],
        [0.06, "3_to_6_percent"],
        [0.12, "6_to_12_percent"],
      ],
      "at_least_12_percent",
    ))),
    graphemeBands: distribution(candidates.map((candidate) => bucket(
      candidate.graphemeCount,
      [
        [2, "one"],
        [3, "two"],
        [5, "three_or_four"],
      ],
      "five_or_six",
    ))),
    scriptBuckets: distribution(candidates.map((candidate) => scriptBucket(
      candidate.normalizedText,
    ))),
    mostCommonOcrTexts: Object.fromEntries(Object.entries(sourceTextCounts).slice(0, 20)),
    expressionTags: tagCounts,
  };
}

function formatPercent(value: unknown): string {
  return `${((value as number) * 100).toFixed(1)}%`;
}

function formatNumber(value: unknown, digits = 3): string {
  return typeof value === "number" ? value.toFixed(digits) : "n/a";
}

function buildMarkdown(summary: Record<string, any>, sheetPaths: string[]): string {
  const face = summary.faceExpression;
  const counts = summary.counts;
  const topTags = Object.entries(face.expressionTags)
    .slice(0, 10)
    .map(([tag, count]) => `${tag} (${count})`)
    .join(", ");
  const topTexts = Object.entries(face.mostCommonOcrTexts)
    .slice(0, 12)
    .map(([text, count]) => `\`${text}\` (${count})`)
    .join(", ");
  return `# Danbooru 项目 Pipeline：脸部/表情 OCR 误识别复核

本报告基于本项目 detector → bubble → OCR → merge → order 的批处理结果，不是直接运行 PP-OCR。

## 人工复核结论

- 高优先级候选：${counts.reviewedCandidates} 个。
- 明确由脸、眼睛、嘴或表情触发的误识别：${counts.faceExpression} 个，来自 ${face.distinctImageCount} 张图。
- 整个人物或漫画格被大框吞入：${counts.broadCharacterOrPanel} 个。
- 两类明确误检合计：${counts.clearFalsePositive} 个（${formatPercent(counts.clearFalsePositiveRatio)}）。
- 脸与真实文字混在同一框、不能仅凭截图归为纯误检：${counts.faceTextMixed} 个。
- 其他人物纹理/物体/服装：${counts.nonFaceArt} 个；真实文字/拟声字/标志：${counts.actualText} 个。

这 49 个是高召回候选中人工确认的下限，不等于 4000 张图中所有脸部误识别的完整召回率。

## 明确脸部/表情误识别的量化共性

- OCR 字符长度：单字素 ${face.singleGrapheme.count}/${face.candidateCount}（${formatPercent(face.singleGrapheme.ratio)}）；中位数 ${formatNumber(face.graphemeCount.median, 1)}。
- OCR 置信度：中位数 ${formatNumber(face.probability.median)}，范围 ${formatNumber(face.probability.min)}–${formatNumber(face.probability.max)}；≥0.8 的仍有 ${face.highConfidenceAtLeastPointEight.count} 个，≥0.9 的有 ${face.highConfidenceAtLeastPointNine.count} 个。
- 区域面积：相对整图中位数 ${formatPercent(face.relativeArea.median)}，四分位区间 ${formatPercent(face.relativeArea.p25)}–${formatPercent(face.relativeArea.p75)}。
- 框形状：长宽比 ≤2 的紧凑框 ${face.nearSquareOrCompact.count}/${face.candidateCount}（${formatPercent(face.nearSquareOrCompact.ratio)}）。
- 气泡关联：无 bubble match ${face.noBubbleMatch.count}/${face.candidateCount}（${formatPercent(face.noBubbleMatch.ratio)}）。
- 常见 OCR 输出：${topTexts}。
- 图级 Danbooru 表情标签：${topTags}。

## 视觉共性

1. 眼睛最容易形成字符形状：大圆瞳孔、细长闭眼弧线、粗睫毛和高反差眼白会被解释成 O/0/C/D/6 或短拉丁组合。
2. 嘴与脸部轮廓会补全“字符”：张嘴、笑嘴、下巴轮廓与鼻点组合后，detector 往往给出近方形框，OCR 再强行解码为单字或字母。
3. 夸张表情和 Q 版脸占比高：闭眼笑、惊讶、害羞、张嘴、腮红排线、汗滴等局部线条密度接近手写文字。
4. 背景越干净、轮廓越粗、脸越占满漫画格，越容易从“局部纹理误检”升级为“整张脸/整个人物大框”。
5. 置信度不能单独作为硬过滤条件；本批明确反例中包含 p≥0.9 的脸部误识别。

## 建议用于后处理的信号组合

优先使用组合判定：短 OCR（尤其 1–2 字素） + 无气泡 + 紧凑/近方形框 + 人脸/眼睛区域重叠 + 局部非文字结构。仅在多个信号同时满足时过滤；高置信度不直接放行，而是降低过滤权重。整格/整图的大框应单独设保护规则，避免其进入 inpaint。

## 复核联系表

${sheetPaths.map((path) => `- [${path}](${path})`).join("\n")}
`;
}

async function main(): Promise<void> {
  const analysisDir = resolve(readOption("analysis") ?? DEFAULT_ANALYSIS_DIR);
  const candidatesPath = join(analysisDir, "priority-candidates.json");
  const reviewPath = join(analysisDir, "priority-candidate-review.json");
  const candidates = JSON.parse(await readFile(candidatesPath, "utf8")) as Candidate[];
  const review = JSON.parse(await readFile(reviewPath, "utf8")) as ReviewFile;
  const labelsByIndex = validateReview(candidates, review);
  const reviewed = candidates.map((candidate, index): ReviewedCandidate => ({
    ...candidate,
    reviewIndex: index + 1,
    reviewLabel: labelsByIndex.get(index + 1)!,
  }));
  const byLabel = Object.fromEntries(REVIEW_LABELS.map((label) => [
    label,
    reviewed.filter((candidate) => candidate.reviewLabel === label),
  ])) as Record<ReviewLabel, ReviewedCandidate[]>;
  const faceCandidates = byLabel.face_expression;
  const sheetPaths = await renderContactSheets(faceCandidates, analysisDir);
  const clearFalsePositiveCount = (
    byLabel.face_expression.length + byLabel.broad_character_or_panel.length
  );
  const summary = {
    createdAt: new Date().toISOString(),
    analysisDir,
    candidatesPath,
    reviewPath,
    counts: {
      reviewedCandidates: reviewed.length,
      faceExpression: byLabel.face_expression.length,
      broadCharacterOrPanel: byLabel.broad_character_or_panel.length,
      faceTextMixed: byLabel.face_text_mixed.length,
      nonFaceArt: byLabel.non_face_art.length,
      actualText: byLabel.actual_text.length,
      clearFalsePositive: clearFalsePositiveCount,
      clearFalsePositiveRatio: percentage(clearFalsePositiveCount, reviewed.length),
    },
    distinctImagesByLabel: Object.fromEntries(REVIEW_LABELS.map((label) => [
      label,
      new Set(byLabel[label].map((candidate) => candidate.input)).size,
    ])),
    faceExpression: summarizeFaceCandidates(faceCandidates),
    reviewedFaceContactSheets: sheetPaths,
    limitations: [
      "The 174 manually reviewed candidates are a high-recall heuristic subset, not every ordered OCR region.",
      "Counts therefore establish confirmed examples and candidate precision, not full-dataset recall.",
      "Danbooru expression tags describe the whole image and are supporting metadata, not box-level ground truth.",
    ],
  };

  await Promise.all([
    writeFile(
      join(analysisDir, "reviewed-priority-candidates.json"),
      JSON.stringify(reviewed, null, 2),
      "utf8",
    ),
    writeFile(
      join(analysisDir, "review-summary.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    ),
    writeFile(
      join(analysisDir, "review-summary.md"),
      buildMarkdown(summary, sheetPaths),
      "utf8",
    ),
  ]);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
