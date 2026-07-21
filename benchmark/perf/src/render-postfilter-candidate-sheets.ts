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
const COLUMNS = 3;
const ROWS = 3;
const TILE_WIDTH = 520;
const TILE_HEIGHT = 430;
const LABEL_HEIGHT = 70;
const PAGE_SIZE = COLUMNS * ROWS;

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
  probability: number;
  relativeArea: number;
  reviewLabel?: string;
  imageWidth: number;
  imageHeight: number;
  box: Rect;
  faceFeatures: {
    maxFaceScore: number;
    maxIntersectionOverRegion: number;
  };
};

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function contextRect(candidate: Candidate): Rect {
  const { box, imageWidth, imageHeight } = candidate;
  const paddingX = Math.max(box.width * 0.55, imageWidth * 0.04);
  const paddingY = Math.max(box.height * 0.55, imageHeight * 0.04);
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

async function main(): Promise<void> {
  const analysisDir = resolve(readOption("analysis") ?? DEFAULT_ANALYSIS_DIR);
  const inputPath = resolve(
    readOption("input") ?? join(analysisDir, "anime-face-postfilter-flagged.json"),
  );
  const unreviewedOnly = process.argv.includes("--unreviewed");
  const allCandidates = JSON.parse(
    await readFile(inputPath, "utf8"),
  ) as Candidate[];
  const candidates = unreviewedOnly
    ? allCandidates.filter((candidate) => candidate.reviewLabel === undefined)
    : allCandidates;
  const directoryName = unreviewedOnly
    ? "anime-face-postfilter-unreviewed-sheets"
    : "anime-face-postfilter-sheets";
  const outputDir = join(analysisDir, directoryName);
  await mkdir(outputDir, { recursive: true });
  const outputs: string[] = [];

  for (let page = 0; page * PAGE_SIZE < candidates.length; page += 1) {
    const rows = candidates.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const canvas = createCanvas(COLUMNS * TILE_WIDTH, ROWS * TILE_HEIGHT);
    const context = canvas.getContext("2d");
    context.fillStyle = "#101318";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < rows.length; index += 1) {
      const candidate = rows[index];
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
      context.lineWidth = 5;
      context.strokeRect(
        offsetX + (candidate.box.x - crop.x) * scale,
        offsetY + (candidate.box.y - crop.y) * scale,
        candidate.box.width * scale,
        candidate.box.height * scale,
      );

      context.fillStyle = "#f5f7fa";
      context.font = "bold 17px Segoe UI";
      context.fillText(
        `${page * PAGE_SIZE + index + 1}. ${candidate.input} · OCR=${candidate.sourceText}`,
        tileX + 10,
        tileY + 24,
        TILE_WIDTH - 20,
      );
      context.font = "14px Segoe UI";
      context.fillText(
        `p=${candidate.probability.toFixed(3)} · area=${(candidate.relativeArea * 100).toFixed(2)}% · face=${candidate.faceFeatures.maxFaceScore.toFixed(3)} · cover=${candidate.faceFeatures.maxIntersectionOverRegion.toFixed(2)}`,
        tileX + 10,
        tileY + 50,
        TILE_WIDTH - 20,
      );
      context.strokeStyle = "#2d3642";
      context.lineWidth = 1;
      context.strokeRect(tileX + 1, tileY + 1, TILE_WIDTH - 2, TILE_HEIGHT - 2);
    }
    const outputPath = join(
      outputDir,
      `contact-sheet-${String(page + 1).padStart(3, "0")}.jpg`,
    );
    await writeFile(outputPath, canvas.toBuffer("image/jpeg", { quality: 0.92 }));
    outputs.push(relative(analysisDir, outputPath).replaceAll("\\", "/"));
  }
  console.log(JSON.stringify({
    inputPath,
    unreviewedOnly,
    candidateCount: candidates.length,
    outputs,
  }, null, 2));
}

await main();
