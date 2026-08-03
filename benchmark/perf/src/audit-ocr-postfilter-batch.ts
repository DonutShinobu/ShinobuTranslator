import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OCR_POST_FILTER_RULE_ID } from '@shinobu/image-pipeline/benchmark';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REQUIRED_WEBGPU_MODELS = ["detector", "bubble", "ocr"] as const;

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Region = {
  id: string;
  box: Rect;
  sourceText: string;
};

type Variant = {
  name: string;
  text: string;
  confidence: number;
  accepted: boolean;
};

type Decision = {
  regionId: string;
  sourceText: string;
  relativeArea: number;
  aspectRatio: number;
  variants: Variant[];
  mask: {
    maskFillRatioInQuad: number;
    componentCount: number;
    largestComponentRatio: number;
    boundaryPixelRatio: number;
  };
  eligible: boolean;
  shouldFilter: boolean;
  majorityAgreement: boolean;
  variantScriptDrift: boolean;
  nonEmptyScriptDrift: boolean;
  originalVariantConfidence: number;
  maskSignalCount: number;
  junkLikeSource: boolean;
  poorConsensus: boolean;
  protectionReason: string | null;
};

type BatchRecord = {
  index: number;
  input: string;
  imageWidth: number;
  imageHeight: number;
  durationMs: number;
  stageRegions: {
    merged: Region[];
    ordered: Region[];
  };
  runtimeStages: Array<{
    model: string;
    enabled: boolean;
    engine?: string;
    provider?: string;
    detail: string;
  }>;
  ocrPostFilterDebug?: {
    mode: "off" | "balanced";
    ruleId: string;
    candidateCount: number;
    filteredCount: number;
    filteredRegionIds: string[];
    decisions: Decision[];
    durationMs: number;
    skippedReason?: "disabled" | "no-mask" | "no-candidates" | "error";
    error?: string;
  } | null;
};

type BatchSummary = {
  createdAt: string;
  inputDir: string;
  outputDir: string;
  concurrency: number;
  ocrPostFilter: string;
  total: number;
  completed: number;
  failed: number;
  durationMs: number;
  results: Array<{
    index: number;
    input: string;
    output: string;
    durationMs: number;
  }>;
  failures: Array<{
    index: number;
    input: string;
    error: string;
  }>;
};

type AuditIssue = {
  severity: "blocker" | "warning";
  code: string;
  input?: string;
  detail: string;
};

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function collectResultFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "batch-summary.json") {
        files.push(path);
      }
    }
  };
  await walk(root);
  return files;
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

function sameSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

function markdownEscape(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function main(): Promise<void> {
  const allowPartial = process.argv.includes("--allow-partial");
  const batchDir = resolve(readOption("batch") ?? join(
    ROOT,
    "benchmark",
    "reports",
    "danbooru-postfilter-full-audit-v1-20260721",
  ));
  const outputDir = resolve(readOption("output") ?? join(
    ROOT,
    "benchmark",
    "reports",
    "danbooru-postfilter-full-audit-analysis-v1-20260721",
  ));
  const expectedTotal = Number(readOption("expected-total") ?? "4000");
  const resultFiles = await collectResultFiles(batchDir);
  const records: BatchRecord[] = [];
  const issues: AuditIssue[] = [];

  for (const path of resultFiles) {
    try {
      records.push(JSON.parse(await readFile(path, "utf8")) as BatchRecord);
    } catch (error) {
      issues.push({
        severity: "blocker",
        code: "invalid-result-json",
        detail: `${relative(batchDir, path)}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  records.sort((left, right) => left.index - right.index);
  let summary: BatchSummary;
  try {
    summary = JSON.parse(
      await readFile(join(batchDir, "batch-summary.json"), "utf8"),
    ) as BatchSummary;
  } catch (error) {
    if (!allowPartial) throw error;
    summary = {
      createdAt: new Date().toISOString(),
      inputDir: "partial-run",
      outputDir: batchDir,
      concurrency: 0,
      ocrPostFilter: "balanced",
      total: expectedTotal,
      completed: records.length,
      failed: 0,
      durationMs: 0,
      results: records.map((record) => ({
        index: record.index,
        input: record.input,
        output: "",
        durationMs: record.durationMs,
      })),
      failures: [],
    };
  }

  const duplicateInputs = [...new Set(
    records
      .map((record) => record.input)
      .filter((input, index, all) => all.indexOf(input) !== index),
  )];
  const duplicateIndices = [...new Set(
    records
      .map((record) => record.index)
      .filter((index, position, all) => all.indexOf(index) !== position),
  )];
  const summaryInputs = new Set(summary.results.map((item) => item.input));
  const recordInputs = new Set(records.map((record) => record.input));
  const missingResultInputs = [...summaryInputs].filter((input) => !recordInputs.has(input));
  const unexpectedResultInputs = [...recordInputs].filter((input) => !summaryInputs.has(input));
  const noTextFailures = summary.failures.filter((failure) => (
    failure.error.includes("文本检测失败: 未找到文本")
  ));
  const noOcrResultFailures = summary.failures.filter((failure) => (
    failure.error.includes("OCR失败: OCR 未返回有效识别结果")
  ));
  const technicalFailures = summary.failures.filter((failure) => (
    !failure.error.includes("文本检测失败: 未找到文本")
    && !failure.error.includes("OCR失败: OCR 未返回有效识别结果")
  ));
  const allSummaryInputs = [
    ...summary.results.map((item) => item.input),
    ...summary.failures.map((item) => item.input),
  ];
  const allSummaryIndices = [
    ...summary.results.map((item) => item.index),
    ...summary.failures.map((item) => item.index),
  ];

  const addGlobalBlocker = (condition: boolean, code: string, detail: string): void => {
    if (condition) issues.push({ severity: "blocker", code, detail });
  };
  addGlobalBlocker(summary.total !== expectedTotal, "unexpected-input-count", `summary.total=${summary.total}, expected=${expectedTotal}`);
  addGlobalBlocker(summary.completed + summary.failed !== expectedTotal, "unaccounted-batch-items", `completed+failed=${summary.completed + summary.failed}, expected=${expectedTotal}`);
  addGlobalBlocker(summary.failed !== summary.failures.length, "failure-count-mismatch", `summary.failed=${summary.failed}, failure rows=${summary.failures.length}`);
  addGlobalBlocker(technicalFailures.length > 0, "technical-batch-failures", `${technicalFailures.length} failure(s) were not the expected no-text detector exit`);
  addGlobalBlocker(new Set(allSummaryInputs).size !== allSummaryInputs.length, "duplicate-summary-inputs", "completed and failed summary items do not have unique input paths");
  addGlobalBlocker(new Set(allSummaryIndices).size !== allSummaryIndices.length, "duplicate-summary-indices", "completed and failed summary items do not have unique indices");
  addGlobalBlocker(records.length !== summary.completed, "result-file-count-mismatch", `${records.length} JSON records for ${summary.completed} completed items`);
  addGlobalBlocker(duplicateInputs.length > 0, "duplicate-inputs", `${duplicateInputs.length} duplicate input path(s)`);
  addGlobalBlocker(duplicateIndices.length > 0, "duplicate-indices", `${duplicateIndices.length} duplicate index value(s)`);
  addGlobalBlocker(missingResultInputs.length > 0, "missing-result-files", `${missingResultInputs.length} summary item(s) have no readable result JSON`);
  addGlobalBlocker(unexpectedResultInputs.length > 0, "unexpected-result-files", `${unexpectedResultInputs.length} result JSON input(s) are absent from the summary`);
  addGlobalBlocker(summary.ocrPostFilter !== "balanced", "wrong-summary-mode", `ocrPostFilter=${summary.ocrPostFilter}`);

  const features: Array<Record<string, unknown>> = [];
  const hits: Array<Record<string, unknown>> = [];
  const skipCounts = new Map<string, number>();
  let candidateCount = 0;
  let filteredCount = 0;
  let candidateImageCount = 0;
  let filteredImageCount = 0;
  let webGpuImageCount = 0;

  for (const record of records) {
    const debug = record.ocrPostFilterDebug;
    const runtimeOkay = REQUIRED_WEBGPU_MODELS.every((model) => {
      const stage = record.runtimeStages.find((item) => item.model === model);
      return stage?.enabled && stage.provider === "webgpu"
        && (model !== "detector" || stage.engine === "onnx");
    });
    if (runtimeOkay) {
      webGpuImageCount += 1;
    } else {
      issues.push({
        severity: "blocker",
        code: "runtime-not-webgpu",
        input: record.input,
        detail: "detector/bubble/ocr did not all run with the required WebGPU providers",
      });
    }
    if (!debug) {
      issues.push({
        severity: "blocker",
        code: "missing-postfilter-debug",
        input: record.input,
        detail: "ocrPostFilterDebug is absent",
      });
      continue;
    }
    if (debug.skippedReason) {
      skipCounts.set(debug.skippedReason, (skipCounts.get(debug.skippedReason) ?? 0) + 1);
      if (debug.skippedReason !== "no-candidates") {
        issues.push({
          severity: "blocker",
          code: `postfilter-skipped-${debug.skippedReason}`,
          input: record.input,
          detail: debug.error ?? `post-filter skipped: ${debug.skippedReason}`,
        });
      }
    }
    if (debug.mode !== "balanced") {
      issues.push({ severity: "blocker", code: "wrong-record-mode", input: record.input, detail: `mode=${debug.mode}` });
    }
    if (debug.ruleId !== OCR_POST_FILTER_RULE_ID) {
      issues.push({ severity: "blocker", code: "wrong-rule-id", input: record.input, detail: `ruleId=${debug.ruleId}` });
    }
    if (debug.decisions.length !== debug.candidateCount) {
      issues.push({
        severity: "blocker",
        code: "decision-count-mismatch",
        input: record.input,
        detail: `${debug.decisions.length} decisions for candidateCount=${debug.candidateCount}`,
      });
    }
    if (debug.candidateCount > 0) candidateImageCount += 1;
    if (debug.filteredCount > 0) filteredImageCount += 1;
    candidateCount += debug.candidateCount;
    filteredCount += debug.filteredCount;

    const decisionFilteredIds = debug.decisions
      .filter((decision) => decision.shouldFilter)
      .map((decision) => decision.regionId);
    if (debug.filteredCount !== decisionFilteredIds.length
      || !sameSet(debug.filteredRegionIds, decisionFilteredIds)) {
      issues.push({
        severity: "blocker",
        code: "filtered-decision-mismatch",
        input: record.input,
        detail: "filteredCount/filteredRegionIds disagree with shouldFilter decisions",
      });
    }
    const mergedById = new Map(record.stageRegions.merged.map((region) => [region.id, region]));
    const orderedIds = new Set(record.stageRegions.ordered.map((region) => region.id));
    const expectedOrderedIds = record.stageRegions.merged
      .filter((region) => !debug.filteredRegionIds.includes(region.id))
      .map((region) => region.id);
    if (!sameSet(orderedIds, expectedOrderedIds)) {
      issues.push({
        severity: "blocker",
        code: "stage-region-set-mismatch",
        input: record.input,
        detail: "ordered IDs are not exactly merged IDs minus filtered IDs",
      });
    }

    for (const decision of debug.decisions) {
      const region = mergedById.get(decision.regionId);
      if (!region) {
        issues.push({
          severity: "blocker",
          code: "candidate-region-missing",
          input: record.input,
          detail: `candidate ${decision.regionId} is absent from merged regions`,
        });
        continue;
      }
      if (!decision.eligible) {
        issues.push({
          severity: "blocker",
          code: "ineligible-candidate",
          input: record.input,
          detail: `candidate ${decision.regionId} failed the shared evaluator eligibility check`,
        });
      }
      const normalizedVariants = decision.variants.map((variant) => normalizedText(variant.text));
      const nonEmptyVariants = normalizedVariants.filter(Boolean);
      const stableExact = nonEmptyVariants.length === normalizedVariants.length
        && new Set(nonEmptyVariants).size === 1;
      const id = `${record.input}::${decision.regionId}`;
      features.push({
        id,
        input: record.input,
        imageWidth: record.imageWidth,
        imageHeight: record.imageHeight,
        sourceText: decision.sourceText,
        box: region.box,
        variants: decision.variants,
        ocr: {
          stableExact,
          majorityAgreement: decision.majorityAgreement,
        },
        mask: {
          ...decision.mask,
          axisResidual: 0,
        },
        rule: {
          shouldFilter: decision.shouldFilter,
          relativeArea: decision.relativeArea,
          aspectRatio: decision.aspectRatio,
          variantScriptDrift: decision.variantScriptDrift,
          nonEmptyScriptDrift: decision.nonEmptyScriptDrift,
          originalVariantConfidence: decision.originalVariantConfidence,
          maskSignalCount: decision.maskSignalCount,
          junkLikeSource: decision.junkLikeSource,
          poorConsensus: decision.poorConsensus,
          protectionReason: decision.protectionReason,
        },
      });
      if (decision.shouldFilter) {
        hits.push({
          id,
          input: record.input,
          regionId: decision.regionId,
          previousLabel: "unreviewed",
          disposition: "full-dataset production hit",
        });
      }
    }
  }

  const blockers = issues.filter((issue) => issue.severity === "blocker");
  const audit = {
    createdAt: new Date().toISOString(),
    sourceBatchCreatedAt: summary.createdAt,
    batchDir,
    inputDir: summary.inputDir,
    expectedTotal,
    summaryTotal: summary.total,
    completed: summary.completed,
    failed: summary.failed,
    noTextDetectorExits: noTextFailures.length,
    noOcrResultExits: noOcrResultFailures.length,
    technicalFailures: technicalFailures.length,
    fullyAccounted: summary.completed + summary.failed === expectedTotal,
    readableResultFiles: records.length,
    uniqueInputs: recordInputs.size,
    uniqueIndices: new Set(records.map((record) => record.index)).size,
    webGpuImageCount,
    postFilterMode: summary.ocrPostFilter,
    ruleId: OCR_POST_FILTER_RULE_ID,
    candidateImageCount,
    candidateCount,
    filteredImageCount,
    filteredCount,
    skippedReasonCounts: Object.fromEntries([...skipCounts].sort(([left], [right]) => left.localeCompare(right))),
    coverageReadyForManualReview: blockers.length === 0,
    blockerCount: blockers.length,
    warningCount: issues.length - blockers.length,
    issues,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "postfilter-features.json"), JSON.stringify(features, null, 2), "utf8");
  await writeFile(join(outputDir, "postfilter-rule-hits.json"), JSON.stringify({
    createdAt: audit.createdAt,
    ruleId: OCR_POST_FILTER_RULE_ID,
    count: hits.length,
    items: hits,
  }, null, 2), "utf8");
  await writeFile(join(outputDir, "postfilter-full-audit-summary.json"), JSON.stringify(audit, null, 2), "utf8");

  const issueRows = issues.length === 0
    ? "No structural coverage issues found."
    : issues.map((issue, index) => (
      `${index + 1}. **${issue.severity.toUpperCase()} ${issue.code}**`
        + `${issue.input ? ` (${markdownEscape(issue.input)})` : ""}: ${markdownEscape(issue.detail)}`
    )).join("\n");
  const report = `# Danbooru OCR post-filter full-dataset audit\n\n`
    + `Generated: ${audit.createdAt}\n\n`
    + `This report validates structural coverage before visual false-positive review. `
    + `It does not claim zero false positives until every item in postfilter-rule-hits.json is manually classified.\n\n`
    + `## Dataset and run\n\n`
    + `| Check | Value |\n|---|---:|\n`
    + `| Expected images | ${expectedTotal} |\n`
    + `| Batch total | ${summary.total} |\n`
    + `| Completed | ${summary.completed} |\n`
    + `| Failed | ${summary.failed} |\n`
    + `| Expected no-text detector exits | ${noTextFailures.length} |\n`
    + `| Expected no-valid-OCR exits | ${noOcrResultFailures.length} |\n`
    + `| Technical failures | ${technicalFailures.length} |\n`
    + `| Readable result files | ${records.length} |\n`
    + `| Unique inputs | ${recordInputs.size} |\n`
    + `| Required WebGPU runtime | ${webGpuImageCount}/${records.length} |\n`
    + `| Candidate images / regions | ${candidateImageCount} / ${candidateCount} |\n`
    + `| Filtered images / regions requiring review | ${filteredImageCount} / ${filteredCount} |\n`
    + `| Rule | ${OCR_POST_FILTER_RULE_ID} |\n`
    + `| Structurally ready for manual review | ${audit.coverageReadyForManualReview} |\n\n`
    + `## Structural issues\n\n${issueRows}\n\n`
    + `## Required interpretation\n\n`
    + `A dataset-level zero-false-positive result requires both structural coverage above and `
    + `manual classification of all ${filteredCount} filtered regions with zero uncertain items. `
    + `No-text and no-valid-OCR exits are still included in the 4000-image ledger, but cannot be `
    + `post-filter false positives because execution stopped before the post-filter.\n`;
  await writeFile(join(outputDir, "postfilter-full-audit.md"), report, "utf8");
  console.log(JSON.stringify(audit, null, 2));
}

await main();
