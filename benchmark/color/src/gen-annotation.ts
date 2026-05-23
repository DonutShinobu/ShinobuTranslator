import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { FIXTURES_DIR } from "./color-utils";

type Rect = { x: number; y: number; width: number; height: number };
type OcrRegionLogItem = {
  regionId: string;
  direction?: string;
  box: Rect;
  quad?: unknown;
  sourceText: string;
  fgColor?: [number, number, number];
  bgColor?: [number, number, number];
};
type TypesetDebugDownloadData = {
  sourceImageUrl: string;
  ocrRegions: OcrRegionLogItem[];
};

function rgbToHex(rgb: [number, number, number]): string {
  const hex = rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}

function rectToBbox(rect: Rect): [number, number, number, number] {
  return [rect.x, rect.y, rect.width, rect.height];
}

function main(): void {
  const logPath = process.argv[2];
  if (!logPath) {
    console.error("用法: npx tsx benchmark/color/src/gen-annotation.ts <日志JSON文件路径>");
    process.exit(1);
  }

  if (!existsSync(logPath)) {
    console.error(`文件不存在: ${logPath}`);
    process.exit(1);
  }

  const raw = readFileSync(logPath, "utf-8");
  const log: TypesetDebugDownloadData = JSON.parse(raw);

  if (!log.sourceImageUrl) {
    console.error("日志中没有 sourceImageUrl 字段");
    process.exit(1);
  }

  const dataUrlMatch = log.sourceImageUrl.match(/^data:image\/([^;]+);base64,(.+)$/);
  if (!dataUrlMatch) {
    console.error("sourceImageUrl 不是 data URL 格式，无法解码图片");
    process.exit(1);
  }

  const mimeType = dataUrlMatch[1];
  const base64Data = dataUrlMatch[2];
  const imageBuffer = Buffer.from(base64Data, "base64");

  const logStem = basename(logPath, ".json");
  const imageExt = mimeType === "jpeg" ? "jpg" : mimeType;
  const imageFileName = `${logStem}.${imageExt}`;

  mkdirSync(FIXTURES_DIR, { recursive: true });
  const imagePath = join(FIXTURES_DIR, imageFileName);
  writeFileSync(imagePath, imageBuffer);
  console.log(`图片已保存: ${imagePath}`);

  const annotationRegions = log.ocrRegions.map((region) => ({
    regionId: region.regionId,
    sourceText: region.sourceText,
    bbox: rectToBbox(region.box),
    pipelineFg: region.fgColor ? rgbToHex(region.fgColor) : null,
    pipelineBg: region.bgColor ? rgbToHex(region.bgColor) : null,
    expectedFg: null as string | null,
    expectedBg: null as string | null,
  }));

  const annotation = {
    imageFile: imageFileName,
    regions: annotationRegions,
  };

  const annotationFileName = `${logStem}-annotation.json`;
  const annotationPath = join(FIXTURES_DIR, annotationFileName);
  writeFileSync(annotationPath, JSON.stringify(annotation, null, 2));
  console.log(`标注模板已生成: ${annotationPath}`);
  console.log(`  区域数: ${annotationRegions.length}`);
  console.log(`  请在标注模板中填写 expectedFg/expectedBg (hex 格式如 "#191a1b")，null 表示该区域没问题(跳过)`);
}

main();