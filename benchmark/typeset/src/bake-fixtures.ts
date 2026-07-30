import { launchWindowsChrome, openBenchmarkPage } from "./chrome-cdp";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { resolveExtensionBuildTarget } from "../../../apps/extension/scripts/build-targets.mjs";
import type { BakeInfo, Fixture } from "./types";
import type { BakeDirection, BakeResult } from "../../../src/pipeline/bake";
import type { ShinobuBenchmarkWindow } from "../../../src/benchmark/browserEntry";
import { parseBakeDirectionArgs } from "./bake-options";
import { bakeResultRegionToFixtureRegion } from "./fixture-build";
import { parseTypesetSuiteArgs } from "./suite-paths";

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST_DIR = resolveExtensionBuildTarget("benchmark").absoluteOutDir;

type BakeFixturesOptions = {
  imagesDir: string;
  fixturesDir: string;
  direction: BakeDirection;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function imageToDataUrl(path: string): string {
  const ext = extname(path).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const buf = readFileSync(path);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function parseArgs(args: string[]): BakeFixturesOptions {
  const parsed = parseTypesetSuiteArgs(args, { fixtureOutputAlias: true });
  const bakeOptions = parseBakeDirectionArgs(parsed.remainingArgs);
  for (const arg of bakeOptions.remainingArgs) {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  }
  return {
    imagesDir: parsed.paths.imagesDir,
    fixturesDir: parsed.paths.fixturesDir,
    direction: bakeOptions.direction,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.imagesDir)) {
    console.error(`Images directory not found: ${options.imagesDir}`);
    process.exit(1);
  }
  const imageFiles = readdirSync(options.imagesDir).filter((f) =>
    /\.(png|jpe?g|webp)$/i.test(f),
  );
  if (imageFiles.length === 0) {
    console.error(`No images found in ${options.imagesDir}`);
    process.exit(1);
  }

  console.log("Building benchmark extension...");
  execSync("npm run build:benchmark", { cwd: ROOT, stdio: "inherit" });

  console.log(`Writing fixtures to ${options.fixturesDir}`);
  mkdirSync(options.fixturesDir, { recursive: true });

  const chrome = await launchWindowsChrome(DIST_DIR);

  const bakeInfo: BakeInfo = {
    gitCommit: gitCommit(),
    detectorModel: "detector.onnx",
    ocrModel: "PP-OCRv6_medium_rec.onnx",
    direction: options.direction,
  };

  for (const imgFile of imageFiles) {
    console.log(`Baking: ${imgFile}`);
    const imgPath = join(options.imagesDir, imgFile);
    const dataUrl = imageToDataUrl(imgPath);

    const page = await openBenchmarkPage(chrome);
    page.on("console", (msg) => console.log(`  [browser ${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));

    const result = await page.evaluate<
      BakeResult,
      { dataUrl: string; direction: BakeDirection }
    >(async ({ dataUrl: fixtureDataUrl, direction }) => {
      const api = (window as ShinobuBenchmarkWindow).__shinobuBenchmark__;
      if (!api) throw new Error("Benchmark API is unavailable");
      return api.bake(fixtureDataUrl, { direction });
    }, { dataUrl, direction: options.direction });

    const regions = result.regions.map(bakeResultRegionToFixtureRegion);

    const fixture: Fixture = {
      schemaVersion: 1,
      image: {
        file: `images/${imgFile}`,
        width: result.imageWidth,
        height: result.imageHeight,
        sha256: sha256File(imgPath),
      },
      bakedAt: new Date().toISOString(),
      bakedWith: bakeInfo,
      regions,
    };

    const fixtureName = imgFile.replace(/\.[^.]+$/, "") + ".fixture.json";
    writeFileSync(
      join(options.fixturesDir, fixtureName),
      JSON.stringify(fixture, null, 2),
    );
    console.log(`  -> ${fixtureName} (${regions.length} regions)`);
    await page.close();
  }

  await chrome.close();
  console.log("Bake complete.");
}

main();
