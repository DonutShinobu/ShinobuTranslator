import { createCanvas, loadImage, registerFont } from "canvas";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { computeFullVerticalTypeset } from "../../src/pipeline/typesetGeometry";
import type { TextRegion } from "../../src/types";

const ROOT = resolve(import.meta.dirname, "../..");
const BENCH = join(ROOT, "benchmark");
const FONTS_DIR = join(BENCH, "fonts");
const IMAGES_DIR = join(BENCH, "images");

function registerFonts(): void {
  if (!existsSync(FONTS_DIR)) return;
  for (const f of readdirSync(FONTS_DIR)) {
    if (/\.(ttf|otf|woff2?)$/i.test(f)) {
      registerFont(join(FONTS_DIR, f), { family: "BenchFont" });
    }
  }
}

interface GroundTruthColumn {
  index: number;
  text: string;
  charCount: number;
  centerX: number;
  topY: number;
  bottomY: number;
  width: number;
  height: number;
  estimatedFontSize: number;
  charCenters: { y: number }[];
}

async function main(): Promise<void> {
  registerFonts();
  const fontFamily = "BenchFont";

  const fixtureFiles = readdirSync(join(BENCH, "fixtures")).filter((f) => f.endsWith(".fixture.json"));
  if (fixtureFiles.length === 0) {
    console.error("No fixtures found.");
    process.exit(1);
  }

  const measureCanvas = createCanvas(1, 1);
  const measureCtx = measureCanvas.getContext("2d");

  for (const ff of fixtureFiles) {
    const fixture = JSON.parse(readFileSync(join(BENCH, "fixtures", ff), "utf-8"));
    let imgName = fixture.image.file.replace(/^images\//, "");
    let imgPath = join(IMAGES_DIR, imgName);
    if (!existsSync(imgPath)) {
      const candidates = readdirSync(IMAGES_DIR).filter((f) => /\.(png|jpe?g)$/i.test(f));
      const match = candidates.find((c) => {
        const hash = createHash("sha256").update(readFileSync(join(IMAGES_DIR, c))).digest("hex");
        return hash === fixture.image.sha256;
      });
      if (match) imgPath = join(IMAGES_DIR, match);
    }
    if (!existsSync(imgPath)) {
      console.log(`Skipping ${ff}: image not found`);
      continue;
    }

    const img = await loadImage(imgPath);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    for (const region of fixture.regions) {
      const gt: GroundTruthColumn[] = region.groundTruth.columns;
      const box = region.box;

      // Draw region box
      ctx.strokeStyle = "rgba(255, 255, 0, 0.6)";
      ctx.lineWidth = 3;
      ctx.strokeRect(box.x, box.y, box.width, box.height);

      // Compute prediction
      const textRegion: TextRegion = {
        id: region.id,
        box: region.box,
        quad: region.quad,
        direction: region.direction,
        fontSize: region.fontSize,
        fgColor: region.fgColor,
        bgColor: region.bgColor,
        originalLineCount: region.originalLineCount,
        sourceText: region.sourceText,
        translatedText: region.sourceText,
        translatedColumns: region.translatedColumns,
      };

      const vResult = computeFullVerticalTypeset({
        region: textRegion,
        fontFamily,
        measureCtx: measureCtx as unknown as CanvasRenderingContext2D,
      });

      const ox = vResult.expandedRegion.box.x + vResult.boxPadding - vResult.strokePadding;
      const oy = vResult.expandedRegion.box.y + vResult.boxPadding - vResult.strokePadding;

      // Draw ground truth columns (green) — coordinates are absolute
      for (const col of gt) {
        const left = col.centerX - col.width / 2;
        ctx.strokeStyle = "rgba(0, 255, 0, 0.8)";
        ctx.lineWidth = 3;
        ctx.strokeRect(left, col.topY, col.width, col.height);

        for (const cc of col.charCenters) {
          ctx.fillStyle = "rgba(0, 255, 0, 0.6)";
          ctx.beginPath();
          ctx.arc(col.centerX, cc.y, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Draw predicted columns (red)
      for (let i = 0; i < vResult.columns.length; i++) {
        const col = vResult.columns[i];
        const dbox = vResult.debugColumnBoxes[i];
        if (!dbox) continue;

        const px = dbox.x + ox;
        const py = dbox.y + oy;
        ctx.strokeStyle = "rgba(255, 50, 50, 0.8)";
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(px, py, dbox.width, dbox.height);
        ctx.setLineDash([]);

        // char centers
        let penY = dbox.y + oy;
        for (const glyph of col.glyphs) {
          ctx.fillStyle = "rgba(255, 50, 50, 0.6)";
          ctx.beginPath();
          ctx.arc(px + dbox.width / 2, penY + glyph.advanceY / 2, 5, 0, Math.PI * 2);
          ctx.fill();
          penY += glyph.advanceY;
        }
      }

      // Label
      ctx.font = "bold 28px sans-serif";
      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      ctx.fillRect(box.x, box.y - 34, 240, 34);
      ctx.fillStyle = "#fff";
      ctx.fillText(`GT:${gt.length} Pred:${vResult.columns.length}`, box.x + 4, box.y - 8);
    }

    const outPath = join(BENCH, "reports", "visualize.png");
    writeFileSync(outPath, canvas.toBuffer("image/png"));
    console.log(`Wrote: ${outPath}`);
  }
}

main();
