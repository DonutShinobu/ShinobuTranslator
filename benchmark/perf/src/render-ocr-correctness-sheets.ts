import { createCanvas, loadImage } from "canvas";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_ANALYSIS = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-postfilter-study-analysis-v1-20260721",
);
const DEFAULT_IMAGES = join(
  ROOT,
  "benchmark",
  "images",
  "danbooru-translated-comic-4000",
);
const COLUMNS = 3;
const ROWS = 3;
const PAGE_SIZE = COLUMNS * ROWS;
const TILE_WIDTH = 620;
const TILE_HEIGHT = 520;
const LABEL_HEIGHT = 98;

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type OcrVariant = {
  name: string;
  text: string;
  confidence: number;
  accepted: boolean;
};

type FeatureRow = {
  id: string;
  input: string;
  imageWidth: number;
  imageHeight: number;
  sourceText: string;
  box: Rect;
  variants: OcrVariant[];
  ocr: {
    stableExact: boolean;
    majorityAgreement: boolean;
  };
  mask: {
    maskFillRatioInQuad: number;
    componentCount: number;
    axisResidual: number;
  };
};

type Crosswalk = {
  input: string;
  reviewIndex: number;
  reviewLabel: string;
  matchedFeatureId?: string;
};

type RuleHit = {
  id: string;
  input: string;
  previousLabel?: string;
  disposition?: string;
};

type DisplayItem = {
  displayIndex: string;
  input: string;
  reviewIndex?: number;
  reviewLabel?: string;
  disposition?: string;
  feature: FeatureRow;
};

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function contextRect(feature: FeatureRow): Rect {
  const horizontalPadding = Math.max(feature.box.width * 0.45, feature.box.height * 0.35);
  const verticalPadding = Math.max(feature.box.height * 0.45, feature.box.width * 0.2);
  const x = Math.max(0, feature.box.x - horizontalPadding);
  const y = Math.max(0, feature.box.y - verticalPadding);
  const right = Math.min(
    feature.imageWidth,
    feature.box.x + feature.box.width + horizontalPadding,
  );
  const bottom = Math.min(
    feature.imageHeight,
    feature.box.y + feature.box.height + verticalPadding,
  );
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

function truncate(text: string, maximum: number): string {
  const characters = Array.from(text.replace(/\s+/g, " "));
  return characters.length <= maximum
    ? characters.join("")
    : `${characters.slice(0, maximum - 1).join("")}…`;
}

async function main(): Promise<void> {
  const analysisDir = resolve(readOption("analysis") ?? DEFAULT_ANALYSIS);
  const imagesDir = resolve(readOption("images") ?? DEFAULT_IMAGES);
  const selection = readOption("selection") ?? "actual-text";
  const outputDir = resolve(
    readOption("output") ?? join(
      analysisDir,
      selection === "rule-hits"
        ? "postfilter-rule-hit-sheets"
        : "ocr-correctness-sheets",
    ),
  );
  const features = JSON.parse(
    await readFile(join(analysisDir, "postfilter-features.json"), "utf8"),
  ) as FeatureRow[];
  const featureById = new Map(features.map((feature) => [feature.id, feature]));
  let items: DisplayItem[];
  if (selection === "rule-hits") {
    const hitsFile = readOption("hits-file") ?? "postfilter-rule-hits.json";
    const ruleHits = JSON.parse(
      await readFile(join(analysisDir, hitsFile), "utf8"),
    ) as { items: RuleHit[] };
    items = ruleHits.items.flatMap((item, index): DisplayItem[] => {
      const feature = featureById.get(item.id);
      return feature
        ? [{
            displayIndex: String(index + 1),
            input: item.input,
            reviewLabel: item.previousLabel,
            disposition: item.disposition,
            feature,
          }]
        : [];
    });
  } else {
    const crosswalk = JSON.parse(
      await readFile(join(analysisDir, "review-crosswalk.json"), "utf8"),
    ) as Crosswalk[];
    items = crosswalk
      .filter((item) => item.reviewLabel === "actual_text" && item.matchedFeatureId)
      .flatMap((item): DisplayItem[] => {
        const feature = featureById.get(item.matchedFeatureId!);
        return feature
          ? [{
              displayIndex: String(item.reviewIndex),
              input: item.input,
              reviewIndex: item.reviewIndex,
              reviewLabel: item.reviewLabel,
              feature,
            }]
          : [];
      })
      .sort((a, b) => (a.reviewIndex ?? 0) - (b.reviewIndex ?? 0));
  }

  await mkdir(outputDir, { recursive: true });
  const pages: string[] = [];
  for (let pageIndex = 0; pageIndex * PAGE_SIZE < items.length; pageIndex += 1) {
    const pageItems = items.slice(
      pageIndex * PAGE_SIZE,
      (pageIndex + 1) * PAGE_SIZE,
    );
    const canvas = createCanvas(COLUMNS * TILE_WIDTH, ROWS * TILE_HEIGHT);
    const context = canvas.getContext("2d");
    context.fillStyle = "#11151a";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let itemIndex = 0; itemIndex < pageItems.length; itemIndex += 1) {
      const item = pageItems[itemIndex];
      const feature = item.feature;
      const column = itemIndex % COLUMNS;
      const row = Math.floor(itemIndex / COLUMNS);
      const tileX = column * TILE_WIDTH;
      const tileY = row * TILE_HEIGHT;
      const image = await loadImage(join(imagesDir, feature.input));
      const crop = contextRect(feature);
      const contentHeight = TILE_HEIGHT - LABEL_HEIGHT;
      const scale = Math.min(
        TILE_WIDTH / crop.width,
        contentHeight / crop.height,
      );
      const drawWidth = crop.width * scale;
      const drawHeight = crop.height * scale;
      const drawX = tileX + (TILE_WIDTH - drawWidth) / 2;
      const drawY = tileY + (contentHeight - drawHeight) / 2;
      context.fillStyle = "#080a0d";
      context.fillRect(tileX, tileY, TILE_WIDTH, contentHeight);
      context.drawImage(
        image,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        drawX,
        drawY,
        drawWidth,
        drawHeight,
      );
      context.strokeStyle = "#ff3b30";
      context.lineWidth = 4;
      context.strokeRect(
        drawX + (feature.box.x - crop.x) * scale,
        drawY + (feature.box.y - crop.y) * scale,
        feature.box.width * scale,
        feature.box.height * scale,
      );
      context.fillStyle = "#18212b";
      context.fillRect(tileX, tileY + contentHeight, TILE_WIDTH, LABEL_HEIGHT);
      context.fillStyle = "#f4f7fa";
      context.font = "20px sans-serif";
      context.fillText(
        `#${item.displayIndex} ${feature.input}  pipeline=${truncate(feature.sourceText, 18)}`,
        tileX + 10,
        tileY + contentHeight + 25,
      );
      context.fillStyle = "#9bd4ff";
      context.font = "17px sans-serif";
      context.fillText(
        truncate(
          feature.variants
            .map((variant) => (
              `${variant.name}:${variant.text || "∅"}@${variant.confidence.toFixed(2)}`
            ))
            .join(" | "),
          75,
        ),
        tileX + 10,
        tileY + contentHeight + 52,
      );
      context.fillStyle = "#aab7c4";
      context.font = "15px sans-serif";
      context.fillText(
        `stable=${feature.ocr.stableExact} majority=${feature.ocr.majorityAgreement}`
          + ` mask=${feature.mask.maskFillRatioInQuad.toFixed(3)}`
          + ` cc=${feature.mask.componentCount} axis=${feature.mask.axisResidual.toFixed(3)}`,
        tileX + 10,
        tileY + contentHeight + 78,
      );
      if (item.disposition) {
        context.fillStyle = "#ffd580";
        context.font = "13px sans-serif";
        context.fillText(
          truncate(item.disposition, 28),
          tileX + TILE_WIDTH - 210,
          tileY + contentHeight + 24,
        );
      }
      context.strokeStyle = "#36404a";
      context.lineWidth = 2;
      context.strokeRect(tileX, tileY, TILE_WIDTH, TILE_HEIGHT);
    }
    const name = `page-${String(pageIndex + 1).padStart(2, "0")}.png`;
    await writeFile(join(outputDir, name), canvas.toBuffer("image/png"));
    pages.push(name);
  }
  await writeFile(
    join(outputDir, "index.json"),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      count: items.length,
      pages,
      items: items.map((item) => ({
        reviewIndex: item.reviewIndex,
        input: item.input,
        featureId: item.feature.id,
        disposition: item.disposition,
      })),
    }, null, 2),
    "utf8",
  );
  console.log(`Rendered ${items.length} items to ${pages.length} pages: ${outputDir}`);
}

await main();
