import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { FIXTURES_DIR } from "./color-utils";

type AnnotationRegion = {
  regionId: string;
  sourceText: string;
  bbox: [number, number, number, number];
  pipelineFg: string | null;
  pipelineBg: string | null;
  expectedFg: string | null;
  expectedBg: string | null;
};
type Annotation = {
  imageFile: string;
  regions: AnnotationRegion[];
};

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace(/^#/, "");
  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);
  return [r, g, b];
}

function main(): void {
  const annotationPath = process.argv[2];
  if (!annotationPath) {
    console.error("用法: npx tsx benchmark/color/src/gen-fixture.ts <标注模板JSON文件路径>");
    process.exit(1);
  }

  if (!existsSync(annotationPath)) {
    console.error(`文件不存在: ${annotationPath}`);
    process.exit(1);
  }

  const raw = readFileSync(annotationPath, "utf-8");
  const annotation: Annotation = JSON.parse(raw);

  const keptRegions = annotation.regions.filter((region) =>
    region.expectedFg !== null && region.expectedBg !== null,
  );

  if (keptRegions.length === 0) {
    console.error("标注模板中所有区域的 expectedFg/expectedBg 都为 null，没有需要测试的区域");
    process.exit(1);
  }

  const fixtureRegions = keptRegions.map((region) => ({
    bbox: region.bbox,
    expectedFg: hexToRgb(region.expectedFg!),
    expectedBg: hexToRgb(region.expectedBg!),
  }));

  const fixture = {
    imageFile: annotation.imageFile,
    regions: fixtureRegions,
  };

  const annotationStem = basename(annotationPath, ".json");
  const fixtureFileName = annotationStem.replace("-annotation", "-fixture.json");
  const fixturePath = join(FIXTURES_DIR, fixtureFileName);
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  console.log(`Fixture 已生成: ${fixturePath}`);
  console.log(`  图片: ${annotation.imageFile}`);
  console.log(`  区域数: ${fixtureRegions.length} (原始 ${annotation.regions.length}, 跳过 ${annotation.regions.length - keptRegions.length} 个无问题区域)`);
}

main();