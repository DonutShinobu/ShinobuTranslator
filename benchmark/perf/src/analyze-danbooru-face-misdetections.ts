import { createCanvas, loadImage } from "canvas";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rect, TextRegion } from "../../../src/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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
const DEFAULT_METADATA_DIR = join(
  ROOT,
  "..",
  "shinobu-translator-detector",
  "data",
  "raw",
  "danbooru",
  "translated_comic_4000",
);
const DEFAULT_OUTPUT_DIR = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-face-misdetection-analysis-v1-20260721",
);

const CONTACT_SHEET_COLUMNS = 4;
const CONTACT_SHEET_ROWS = 3;
const TILE_WIDTH = 420;
const TILE_HEIGHT = 360;
const LABEL_HEIGHT = 56;
const CONTACT_SHEET_PAGE_SIZE = CONTACT_SHEET_COLUMNS * CONTACT_SHEET_ROWS;

const EXPRESSION_TAGS = new Set([
  ":3",
  ":d",
  ">_<",
  "^_^",
  "angry",
  "blush",
  "closed_eyes",
  "constricted_pupils",
  "crying",
  "dot_nose",
  "drooling",
  "evil_smile",
  "expressionless",
  "face",
  "face_focus",
  "heavy_breathing",
  "open_mouth",
  "parted_lips",
  "ringed_eyes",
  "scared",
  "shaded_face",
  "smile",
  "surprised",
  "sweat",
  "sweatdrop",
  "tears",
  "wide-eyed",
  "wide_eyes",
  "white_pupils",
]);

type SerializableTextRegion = Omit<TextRegion, "bubbleMask">;

type PipelineResult = {
  input: string;
  output: string;
  durationMs: number;
  imageWidth: number;
  imageHeight: number;
  stageRegions: {
    detected: SerializableTextRegion[];
    ocr: SerializableTextRegion[];
    merged: SerializableTextRegion[];
    ordered: SerializableTextRegion[];
  };
};

type DanbooruMetadata = {
  id?: number;
  source?: string;
  tag_string_general?: string;
};

type Candidate = {
  id: string;
  input: string;
  imagePath: string;
  resultPath: string;
  postId?: number;
  sourceUrl?: string;
  imageWidth: number;
  imageHeight: number;
  regionId: string;
  sourceText: string;
  normalizedText: string;
  graphemeCount: number;
  probability: number;
  box: Rect;
  bubbleBox?: Rect;
  originalLineCount: number;
  relativeArea: number;
  widthRatio: number;
  heightRatio: number;
  aspectRatio: number;
  riskScore: number;
  riskSignals: string[];
  expressionTags: string[];
};

type AnalysisOptions = {
  resultsDir: string;
  imagesDir: string;
  metadataDir: string;
  outputDir: string;
};

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseOptions(): AnalysisOptions {
  return {
    resultsDir: resolve(readOption("results") ?? DEFAULT_RESULTS_DIR),
    imagesDir: resolve(readOption("images") ?? DEFAULT_IMAGES_DIR),
    metadataDir: resolve(readOption("metadata") ?? DEFAULT_METADATA_DIR),
    outputDir: resolve(readOption("output") ?? DEFAULT_OUTPUT_DIR),
  };
}

async function collectJsonFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (
        entry.isFile()
        && extname(entry.name).toLowerCase() === ".json"
        && entry.name !== "batch-summary.json"
      ) {
        files.push(path);
      }
    }
  };
  await walk(rootDir);
  return files;
}

function countGraphemes(text: string): number {
  return Array.from(
    new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text),
  ).length;
}

function scriptSignals(text: string): string[] {
  const signals: string[] = [];
  const hasHan = /\p{Script=Han}/u.test(text);
  const hasKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  const hasLatin = /\p{Script=Latin}/u.test(text);
  const hasDigit = /\p{Number}/u.test(text);
  if ((hasHan || hasKana) && (hasLatin || hasDigit)) signals.push("mixed_script");
  if (/^[A-Za-z0-9|IlOo]+$/.test(text)) signals.push("short_ascii_shape");
  if (/^(.)\1+$/u.test(text)) signals.push("repeated_shape");
  return signals;
}

function scoreRegion(
  region: SerializableTextRegion,
  imageWidth: number,
  imageHeight: number,
): Omit<
  Candidate,
  | "id"
  | "input"
  | "imagePath"
  | "resultPath"
  | "postId"
  | "sourceUrl"
  | "imageWidth"
  | "imageHeight"
  | "regionId"
  | "expressionTags"
> | null {
  const normalizedText = region.sourceText.normalize("NFKC").replace(/\s+/g, "").trim();
  if (!normalizedText) return null;

  const graphemeCount = countGraphemes(normalizedText);
  const probability = region.prob ?? 1;
  const width = Math.max(1, region.box.width);
  const height = Math.max(1, region.box.height);
  const relativeArea = (width * height) / Math.max(1, imageWidth * imageHeight);
  const widthRatio = width / Math.max(1, imageWidth);
  const heightRatio = height / Math.max(1, imageHeight);
  const aspectRatio = Math.max(width / height, height / width);
  const originalLineCount = region.originalLineCount ?? 1;

  if (
    graphemeCount > 6
    || relativeArea < 0.015
    || aspectRatio > 3
    || (probability > 0.92 && relativeArea < 0.12)
    || (probability > 0.82 && relativeArea < 0.03)
    || (region.bubbleBox && relativeArea < 0.06)
  ) {
    return null;
  }

  const riskSignals: string[] = [];
  let riskScore = 0;
  if (relativeArea >= 0.25) {
    riskScore += 12;
    riskSignals.push("quarter_image_or_larger");
  } else if (relativeArea >= 0.12) {
    riskScore += 10;
    riskSignals.push("very_large_region");
  } else if (relativeArea >= 0.06) {
    riskScore += 8;
    riskSignals.push("large_region");
  } else if (relativeArea >= 0.03) {
    riskScore += 5;
    riskSignals.push("moderately_large_region");
  } else {
    riskScore += 2;
    riskSignals.push("nontrivial_region");
  }

  if (probability < 0.3) {
    riskScore += 5;
    riskSignals.push("very_low_ocr_confidence");
  } else if (probability < 0.45) {
    riskScore += 4;
    riskSignals.push("low_ocr_confidence");
  } else if (probability < 0.6) {
    riskScore += 3;
    riskSignals.push("moderately_low_ocr_confidence");
  } else if (probability < 0.75) {
    riskScore += 1;
    riskSignals.push("substantial_ocr_uncertainty");
  }

  if (graphemeCount === 1) {
    riskScore += 4;
    riskSignals.push("single_grapheme");
  } else if (graphemeCount === 2) {
    riskScore += 3;
    riskSignals.push("two_graphemes");
  } else if (graphemeCount <= 4) {
    riskScore += 1;
    riskSignals.push("very_short_text");
  }

  if (!region.bubbleBox) {
    riskScore += 3;
    riskSignals.push("no_bubble_match");
  }
  if (aspectRatio <= 1.4) {
    riskScore += 2;
    riskSignals.push("near_square");
  } else if (aspectRatio <= 2) {
    riskScore += 1;
    riskSignals.push("compact_box");
  }
  if (originalLineCount <= 1) {
    riskScore += 1;
    riskSignals.push("single_detector_region");
  }

  const shapeSignals = scriptSignals(normalizedText);
  riskSignals.push(...shapeSignals);
  if (shapeSignals.includes("mixed_script")) riskScore += 3;
  if (shapeSignals.includes("short_ascii_shape")) riskScore += 2;
  if (shapeSignals.includes("repeated_shape")) riskScore += 1;

  if (riskScore < 7) return null;

  return {
    sourceText: region.sourceText,
    normalizedText,
    graphemeCount,
    probability,
    box: region.box,
    bubbleBox: region.bubbleBox,
    originalLineCount,
    relativeArea,
    widthRatio,
    heightRatio,
    aspectRatio,
    riskScore,
    riskSignals,
  };
}

async function readMetadata(
  metadataDir: string,
  input: string,
): Promise<DanbooruMetadata | null> {
  try {
    return JSON.parse(
      await readFile(join(metadataDir, `${basename(input)}.json`), "utf8"),
    ) as DanbooruMetadata;
  } catch {
    return null;
  }
}

function expressionTags(metadata: DanbooruMetadata | null): string[] {
  if (!metadata?.tag_string_general) return [];
  return metadata.tag_string_general
    .split(/\s+/)
    .filter((tag) => EXPRESSION_TAGS.has(tag))
    .sort();
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
  candidates: Candidate[],
  outputDir: string,
  directoryName = "contact-sheets",
): Promise<string[]> {
  const sheetsDir = join(outputDir, directoryName);
  await mkdir(sheetsDir, { recursive: true });
  const sheetPaths: string[] = [];

  for (let page = 0; page * CONTACT_SHEET_PAGE_SIZE < candidates.length; page += 1) {
    const pageCandidates = candidates.slice(
      page * CONTACT_SHEET_PAGE_SIZE,
      (page + 1) * CONTACT_SHEET_PAGE_SIZE,
    );
    const canvas = createCanvas(
      CONTACT_SHEET_COLUMNS * TILE_WIDTH,
      CONTACT_SHEET_ROWS * TILE_HEIGHT,
    );
    const context = canvas.getContext("2d");
    context.fillStyle = "#101318";
    context.fillRect(0, 0, canvas.width, canvas.height);

    for (let index = 0; index < pageCandidates.length; index += 1) {
      const candidate = pageCandidates[index];
      const column = index % CONTACT_SHEET_COLUMNS;
      const row = Math.floor(index / CONTACT_SHEET_COLUMNS);
      const tileX = column * TILE_WIDTH;
      const tileY = row * TILE_HEIGHT;
      const drawY = tileY + LABEL_HEIGHT;
      const drawHeight = TILE_HEIGHT - LABEL_HEIGHT;
      context.fillStyle = "#181d24";
      context.fillRect(tileX + 2, tileY + 2, TILE_WIDTH - 4, TILE_HEIGHT - 4);

      try {
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
      } catch (error) {
        context.fillStyle = "#ff8a8a";
        context.font = "14px Segoe UI";
        context.fillText(
          error instanceof Error ? error.message : String(error),
          tileX + 12,
          drawY + 24,
          TILE_WIDTH - 24,
        );
      }

      context.fillStyle = "#f5f7fa";
      context.font = "bold 16px Segoe UI";
      context.fillText(
        `${page * CONTACT_SHEET_PAGE_SIZE + index + 1}. ${candidate.input}`,
        tileX + 10,
        tileY + 20,
        TILE_WIDTH - 20,
      );
      context.font = "14px Segoe UI";
      context.fillText(
        `OCR=${truncate(candidate.sourceText, 16)}  p=${candidate.probability.toFixed(3)}  area=${(candidate.relativeArea * 100).toFixed(1)}%  risk=${candidate.riskScore}`,
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
    sheetPaths.push(relative(outputDir, path).replaceAll("\\", "/"));
  }

  return sheetPaths;
}

function isPriorityCandidate(candidate: Candidate): boolean {
  return (
    candidate.bubbleBox === undefined
    && candidate.expressionTags.length > 0
    && (
      candidate.probability < 0.55
      || candidate.riskSignals.includes("short_ascii_shape")
      || candidate.riskSignals.includes("mixed_script")
    )
  );
}

function buildHtml(candidates: Candidate[], sheetPaths: string[]): string {
  const escapedCandidates = JSON.stringify(candidates).replaceAll("<", "\\u003c");
  const escapedSheets = JSON.stringify(sheetPaths).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Danbooru 表情/脸部 OCR 误识别候选</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,"Segoe UI",sans-serif;background:#0d1015;color:#eef2f7}
    body{margin:0;padding:24px;max-width:1500px;margin-inline:auto}
    h1{margin:0 0 8px;font-size:28px}.muted{color:#aab4c0}
    .toolbar{position:sticky;top:0;z-index:10;background:#0d1015e8;padding:12px 0;display:flex;gap:12px;align-items:center}
    input,select{background:#171d25;color:#eef2f7;border:1px solid #34404d;border-radius:8px;padding:8px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(390px,1fr));gap:16px}
    .card{background:#151a22;border:1px solid #2c3642;border-radius:12px;padding:12px}
    .stage{position:relative;background:#090b0f;overflow:hidden;border-radius:8px;aspect-ratio:4/3}
    .stage img{width:100%;height:100%;object-fit:contain;display:block}
    .box{position:absolute;border:3px solid #ff334d;box-sizing:border-box;pointer-events:none}
    .meta{font-size:13px;line-height:1.55;margin-top:10px}.meta code{color:#ffb4bf}
    .tags{color:#8ed7ff}.signals{color:#c8d2dc}
    details{margin:14px 0}.sheets img{width:100%;display:block;margin:12px 0;border-radius:10px}
  </style>
</head>
<body>
  <h1>Danbooru 表情/脸部 OCR 误识别候选</h1>
  <p class="muted">候选来自本项目 detector → bubble → OCR → merge → order 的真实批处理结果。红框为最终 ordered 区域。</p>
  <div class="toolbar">
    <input id="query" placeholder="文件名或 OCR">
    <label>最低风险 <input id="minRisk" type="number" value="7" min="0" style="width:72px"></label>
    <label><input id="expressionOnly" type="checkbox"> 仅含表情标签</label>
    <span id="count"></span>
  </div>
  <details>
    <summary>联系表</summary>
    <div id="sheets" class="sheets"></div>
  </details>
  <div id="grid" class="grid"></div>
  <script>
    const candidates=${escapedCandidates};
    const sheetPaths=${escapedSheets};
    const grid=document.querySelector("#grid");
    const count=document.querySelector("#count");
    const query=document.querySelector("#query");
    const minRisk=document.querySelector("#minRisk");
    const expressionOnly=document.querySelector("#expressionOnly");
    document.querySelector("#sheets").innerHTML=sheetPaths.map(path=>'<img loading="lazy" src="'+path+'">').join("");
    const escapeHtml=(value)=>String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
    function render(){
      const needle=query.value.trim().toLowerCase();
      const minimum=Number(minRisk.value)||0;
      const filtered=candidates.filter(candidate=>
        candidate.riskScore>=minimum
        &&(!expressionOnly.checked||candidate.expressionTags.length>0)
        &&(!needle||(candidate.input+" "+candidate.sourceText).toLowerCase().includes(needle))
      );
      count.textContent=filtered.length+" / "+candidates.length;
      grid.innerHTML=filtered.map(candidate=>{
        const left=candidate.box.x/candidate.imageWidth*100;
        const top=candidate.box.y/candidate.imageHeight*100;
        const width=candidate.box.width/candidate.imageWidth*100;
        const height=candidate.box.height/candidate.imageHeight*100;
        const image="../../images/danbooru-translated-comic-4000/"+encodeURIComponent(candidate.input);
        return '<article class="card">'
          +'<div class="stage"><img loading="lazy" src="'+image+'"><i class="box" style="left:'+left+'%;top:'+top+'%;width:'+width+'%;height:'+height+'%"></i></div>'
          +'<div class="meta"><b>'+escapeHtml(candidate.input)+'</b> · <code>'+escapeHtml(candidate.sourceText)+'</code>'
          +'<br>p='+candidate.probability.toFixed(3)+' · area='+(candidate.relativeArea*100).toFixed(2)+'% · aspect='+candidate.aspectRatio.toFixed(2)+' · risk='+candidate.riskScore
          +'<br><span class="tags">'+escapeHtml(candidate.expressionTags.join(" "))+'</span>'
          +'<br><span class="signals">'+escapeHtml(candidate.riskSignals.join(" · "))+'</span></div></article>';
      }).join("");
    }
    query.addEventListener("input",render);
    minRisk.addEventListener("input",render);
    expressionOnly.addEventListener("change",render);
    render();
  </script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const options = parseOptions();
  const resultFiles = await collectJsonFiles(options.resultsDir);
  const candidates: Candidate[] = [];
  let orderedRegionCount = 0;

  for (const resultPath of resultFiles) {
    const result = JSON.parse(await readFile(resultPath, "utf8")) as PipelineResult;
    orderedRegionCount += result.stageRegions.ordered.length;
    const metadata = await readMetadata(options.metadataDir, result.input);
    const tags = expressionTags(metadata);
    for (const region of result.stageRegions.ordered) {
      const scored = scoreRegion(region, result.imageWidth, result.imageHeight);
      if (!scored) continue;
      const expressionBoost = Math.min(3, tags.length);
      candidates.push({
        id: `${result.input}#${region.id}`,
        input: result.input,
        imagePath: join(options.imagesDir, result.input),
        resultPath,
        postId: metadata?.id,
        sourceUrl: metadata?.source,
        imageWidth: result.imageWidth,
        imageHeight: result.imageHeight,
        regionId: region.id,
        ...scored,
        riskScore: scored.riskScore + expressionBoost,
        riskSignals: expressionBoost > 0
          ? [...scored.riskSignals, `expression_tag_support:${expressionBoost}`]
          : scored.riskSignals,
        expressionTags: tags,
      });
    }
  }

  candidates.sort((a, b) => (
    b.riskScore - a.riskScore
    || b.relativeArea - a.relativeArea
    || a.input.localeCompare(b.input)
  ));

  await mkdir(options.outputDir, { recursive: true });
  const priorityCandidates = candidates.filter(isPriorityCandidate);
  const sheetPaths = await renderContactSheets(candidates, options.outputDir);
  const prioritySheetPaths = await renderContactSheets(
    priorityCandidates,
    options.outputDir,
    "priority-contact-sheets",
  );
  const summary = {
    createdAt: new Date().toISOString(),
    resultsDir: options.resultsDir,
    imagesDir: options.imagesDir,
    metadataDir: options.metadataDir,
    outputDir: options.outputDir,
    processedImages: resultFiles.length,
    orderedRegionCount,
    candidateCount: candidates.length,
    imagesWithCandidates: new Set(candidates.map((candidate) => candidate.input)).size,
    contactSheetCount: sheetPaths.length,
    priorityCandidateCount: priorityCandidates.length,
    priorityImagesWithCandidates: new Set(
      priorityCandidates.map((candidate) => candidate.input),
    ).size,
    priorityContactSheetCount: prioritySheetPaths.length,
    thresholds: {
      maximumGraphemeCount: 6,
      minimumRelativeArea: 0.015,
      maximumAspectRatio: 3,
      maximumProbabilityBelowThreePercentArea: 0.82,
      maximumProbabilityBelowTwelvePercentArea: 0.92,
      maximumProbabilityAtOrAboveTwelvePercentArea: null,
      minimumRiskScore: 7,
    },
  };
  await Promise.all([
    writeFile(join(options.outputDir, "candidates.json"), JSON.stringify(candidates, null, 2), "utf8"),
    writeFile(
      join(options.outputDir, "priority-candidates.json"),
      JSON.stringify(priorityCandidates, null, 2),
      "utf8",
    ),
    writeFile(join(options.outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8"),
    writeFile(join(options.outputDir, "index.html"), buildHtml(candidates, sheetPaths), "utf8"),
  ]);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
