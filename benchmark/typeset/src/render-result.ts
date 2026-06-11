import { launchWindowsChrome } from "./chrome-cdp";
import { createCanvas, loadImage } from "canvas";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createServer } from "http";
import type { AddressInfo } from "net";
import type { Fixture, GroundTruthColumn } from "./types";
import type { RenderFixtureRegion } from "../../../src/pipeline/bake";
import type { PipelineTypesetDebugLog, QuadPoint, SourceTextLineGeometry } from "../../../src/types";

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const IMAGES_DIR = join(ROOT, "benchmark/typeset/images");
const REPORTS_DIR = join(ROOT, "benchmark/reports");
const DIST_DIR = join(ROOT, "dist");
const FIXTURES_DIR = join(ROOT, "benchmark/typeset/fixtures");

type RenderDebugResponse = {
  dataUrl: string;
  debugLog: PipelineTypesetDebugLog | null;
};

function imageToDataUrl(path: string): string {
  const ext = extname(path).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const buf = readFileSync(path);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return Buffer.from(base64, "base64");
}

function drawQuad(
  ctx: CanvasRenderingContext2D,
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
): void {
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  ctx.lineTo(quad[1].x, quad[1].y);
  ctx.lineTo(quad[2].x, quad[2].y);
  ctx.lineTo(quad[3].x, quad[3].y);
  ctx.closePath();
}

function groundTruthColumnToSourceGeometry(column: GroundTruthColumn): SourceTextLineGeometry {
  const left = column.centerX - column.width / 2;
  const right = column.centerX + column.width / 2;
  const top = column.topY;
  const bottom = column.bottomY;

  return {
    text: column.text,
    direction: "v",
    box: {
      x: left,
      y: top,
      width: column.width,
      height: column.height,
    },
    quad: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
    centerX: column.centerX,
    centerY: (top + bottom) / 2,
    width: column.width,
    height: column.height,
    fontSize: column.estimatedFontSize,
  };
}

function toRenderFixtureRegions(fixture: Fixture): RenderFixtureRegion[] {
  return fixture.regions.map((region) => ({
    id: region.id,
    direction: region.direction,
    box: region.box,
    quad: region.quad,
    sourceText: region.sourceText,
    fontSize: region.fontSize,
    fgColor: region.fgColor,
    bgColor: region.bgColor,
    originalLineCount: region.originalLineCount,
    translatedColumns: region.translatedColumns,
    sourceLineGeometries: region.groundTruth.columns.map(groundTruthColumnToSourceGeometry),
  }));
}

function resolveFixtureImagePath(fixture: Fixture): string | null {
  const imagePath = join(IMAGES_DIR, fixture.image.file.replace(/^images\//, ""));
  if (existsSync(imagePath)) return imagePath;

  const candidates = readdirSync(IMAGES_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  const match = candidates.find((c) => {
    const path = join(IMAGES_DIR, c);
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    return hash === fixture.image.sha256;
  });
  return match ? join(IMAGES_DIR, match) : null;
}

async function renderDebugOverlay(
  renderedPng: Buffer,
  fixture: Fixture | null,
  debugLog: PipelineTypesetDebugLog | null,
): Promise<Buffer> {
  const img = await loadImage(renderedPng);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  ctx.drawImage(img as unknown as CanvasImageSource, 0, 0);

  if (fixture) {
    ctx.strokeStyle = "rgba(0, 210, 70, 0.85)";
    ctx.fillStyle = "rgba(0, 210, 70, 0.75)";
    ctx.lineWidth = 2;
    for (const region of fixture.regions) {
      for (const col of region.groundTruth.columns) {
        const left = col.centerX - col.width / 2;
        ctx.strokeRect(left, col.topY, col.width, col.height);
        for (const center of col.charCenters) {
          ctx.beginPath();
          ctx.arc(col.centerX, center.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  if (debugLog) {
    ctx.strokeStyle = "rgba(255, 45, 45, 0.9)";
    ctx.fillStyle = "rgba(255, 45, 45, 0.75)";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    for (const region of debugLog.regions) {
      for (const quad of region.columnCanvasQuads) {
        drawQuad(ctx, quad);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    for (const region of debugLog.regions) {
      for (const column of region.columnGlyphCenters) {
        for (const center of column) {
          ctx.beginPath();
          ctx.arc(center.x, center.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  return canvas.toBuffer("image/png");
}

async function main(): Promise<void> {
  console.log("Building extension...");
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

  const manifestPath = join(DIST_DIR, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.content_scripts[0].matches = ["http://localhost/*", ...manifest.content_scripts[0].matches];
  if (!manifest.host_permissions) manifest.host_permissions = [];
  if (!manifest.host_permissions.includes("http://localhost/*")) {
    manifest.host_permissions.push("http://localhost/*");
  }
  if (!manifest.permissions) manifest.permissions = [];
  if (!manifest.permissions.includes("scripting")) {
    manifest.permissions.push("scripting");
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    if (!war.matches.includes("http://localhost/*")) {
      war.matches.push("http://localhost/*");
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve benchmark server port.");
  }
  const port = (address as AddressInfo).port;
  const localUrl = `http://localhost:${port}/`;

  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".fixture.json"));
  if (fixtureFiles.length === 0) {
    console.error("No fixtures found. Run npm run bench:bake first.");
    process.exit(1);
  }

  const outputDir = join(REPORTS_DIR, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outputDir, { recursive: true });

  const { context, close: closeBrowser } = await launchWindowsChrome(DIST_DIR);

  for (const fixtureFile of fixtureFiles) {
    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, fixtureFile), "utf-8")) as Fixture;
    const imgPath = resolveFixtureImagePath(fixture);
    if (!imgPath) {
      console.log(`Skipping ${fixtureFile}: image not found`);
      continue;
    }
    const imgFile = fixture.image.file.replace(/^images\//, "");
    console.log(`Rendering fixture: ${imgFile}`);
    const dataUrl = imageToDataUrl(imgPath);

    const page = await context.newPage();
    page.on("console", (msg) => console.log(`  [browser ${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));

    await page.addInitScript(`
      window.__shinobu_bridge_ready__ = false;
      window.addEventListener("message", (e) => {
        if (e.data?.type === "__shinobu_bake_ready__") {
          window.__shinobu_bridge_ready__ = true;
        }
      });
    `);

    await page.goto(localUrl, { waitUntil: "load" });
    await page.waitForFunction('window.__shinobu_bridge_ready__ === true', { timeout: 15_000 });

    await page.evaluate(
      ({ du, regions }: { du: string; regions: RenderFixtureRegion[] }) => {
        (window as typeof window & {
          __shinobu_render_fixture__?: { dataUrl: string; regions: RenderFixtureRegion[] };
        }).__shinobu_render_fixture__ = { dataUrl: du, regions };
      },
      { du: dataUrl, regions: toRenderFixtureRegions(fixture) },
    );
    const result: RenderDebugResponse = await page.evaluate(`
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Render timeout")), 120000);
        const handler = (e) => {
          if (e.data?.type !== "__shinobu_render_fixture_debug_response__") return;
          window.removeEventListener("message", handler);
          clearTimeout(timeout);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data.result);
        };
        window.addEventListener("message", handler);
        window.postMessage({
          type: "__shinobu_render_fixture_debug_request__",
          dataUrl: window.__shinobu_render_fixture__.dataUrl,
          regions: window.__shinobu_render_fixture__.regions,
        }, "*");
      })
    `);

    const stem = imgFile.replace(/\.[^.]+$/, "");
    const renderedPng = dataUrlToBuffer(result.dataUrl);
    const outName = stem + "_render.png";
    writeFileSync(join(outputDir, outName), renderedPng);
    writeFileSync(
      join(outputDir, stem + "_render-debug.json"),
      JSON.stringify(result.debugLog, null, 2),
    );
    const overlay = await renderDebugOverlay(renderedPng, fixture, result.debugLog);
    writeFileSync(join(outputDir, stem + "_render-overlay.png"), overlay);
    console.log(`  -> ${outName}`);
    await page.close();
  }

  await closeBrowser();
  server.close();
  console.log(`Render complete. Output: ${outputDir}`);
}

main();
