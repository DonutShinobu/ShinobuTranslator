#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, ".tmp", "model-variants", "runtime-ort-best");
const distFlagIndex = process.argv.indexOf("--dist");
const requestedDist = distFlagIndex >= 0 ? process.argv[distFlagIndex + 1] : undefined;
if (!requestedDist || requestedDist.startsWith("--")) {
  throw new Error("--dist is required and must name dist-chromium or dist-firefox");
}
const resolvedDist = resolve(process.cwd(), requestedDist);
if (!/dist-(?:chromium|firefox)$/.test(resolvedDist.replaceAll("\\", "/"))) {
  throw new Error(`Refusing ambiguous extension output directory: ${resolvedDist}`);
}
const DIST_MODELS_DIR = join(resolvedDist, "models");
const MANIFEST_PATH = join(DIST_MODELS_DIR, "models.json");

const MODELS = [
  {
    key: "detector",
    source: join(ROOT, "public", "models", "detector.onnx"),
    outputName: "detector.with_runtime_opt.ort",
    distName: "detector.with_runtime_opt.ort",
    originalUrl: "/models/detector.onnx",
    runtimeOrtUrl: "/models/detector.with_runtime_opt.ort",
  },
  {
    key: "paddleocr_v6_medium_rec",
    source: join(ROOT, "public", "models", "PP-OCRv6_medium_rec.onnx"),
    outputName: "PP-OCRv6_medium_rec.with_runtime_opt.ort",
    distName: "PP-OCRv6_medium_rec.ort",
    originalUrl: "/models/PP-OCRv6_medium_rec.onnx",
    runtimeOrtUrl: "/models/PP-OCRv6_medium_rec.ort",
  },
];

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function updateManifest(useRuntimeOrt) {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Missing dist manifest: ${MANIFEST_PATH}. Run npm run build first.`);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  for (const model of MODELS) {
    if (!manifest.models?.[model.key]) {
      throw new Error(`Manifest is missing model: ${model.key}`);
    }
    manifest.models[model.key].url = useRuntimeOrt ? model.runtimeOrtUrl : model.originalUrl;
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function convertModel(model, force) {
  const outputPath = join(OUT_DIR, model.outputName);
  if (existsSync(outputPath) && !force) {
    return outputPath;
  }
  if (!existsSync(model.source)) {
    throw new Error(`Missing source model: ${model.source}`);
  }
  const result = spawnSync(
    "python",
    [
      "-m",
      "onnxruntime.tools.convert_onnx_models_to_ort",
      model.source,
      "--output_dir",
      OUT_DIR,
      "--optimization_style",
      "Runtime",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`ORT conversion failed for ${model.source}`);
  }
  if (!existsSync(outputPath)) {
    throw new Error(`ORT conversion did not create ${outputPath}`);
  }
  return outputPath;
}

function prepareRuntimeOrt() {
  const force = hasFlag("force");
  mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(DIST_MODELS_DIR)) {
    throw new Error(`Missing dist models directory: ${DIST_MODELS_DIR}. Run npm run build first.`);
  }
  for (const model of MODELS) {
    const outputPath = convertModel(model, force);
    copyFileSync(outputPath, join(DIST_MODELS_DIR, model.distName));
  }
  updateManifest(true);
  console.log(JSON.stringify({
    manifest: MANIFEST_PATH,
    models: Object.fromEntries(MODELS.map((model) => [model.key, model.runtimeOrtUrl])),
  }, null, 2));
}

if (hasFlag("restore")) {
  updateManifest(false);
  console.log(JSON.stringify({
    manifest: MANIFEST_PATH,
    restored: Object.fromEntries(MODELS.map((model) => [model.key, model.originalUrl])),
  }, null, 2));
} else {
  prepareRuntimeOrt();
}
