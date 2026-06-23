import { readFileSync } from "fs";
import { resolve } from "path";

type PaddleSummary = {
  acceptedCount: number;
  rejectedCount: number;
  inferenceRunCount: number;
  inferenceTotalMs: number;
};

type PipelineRun = {
  totalMs: number;
  sourceCharCount: number;
  sourceTexts?: string[];
  sampleTexts: string[];
  ocrSummary: {
    stageMs: number;
    paddle?: PaddleSummary;
  };
};

type PipelineReport = {
  modes: Array<{
    warmMedian: {
      totalMs: number;
      ocrStageMs: number;
    };
    runs: PipelineRun[];
  }>;
};

function usage(): void {
  console.log("Usage: npm run bench:compare-reports -- <base-report.json> <candidate-report.json>");
}

function readReport(path: string): PipelineReport {
  return JSON.parse(readFileSync(path, "utf8")) as PipelineReport;
}

function firstRun(report: PipelineReport, label: string): PipelineRun {
  const run = report.modes[0]?.runs[0];
  if (!run) {
    throw new Error(`${label} report has no first run`);
  }
  return run;
}

function reportTexts(run: PipelineRun): string[] {
  return run.sourceTexts ?? run.sampleTexts;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function main(): void {
  const [baseArg, candidateArg] = process.argv.slice(2);
  if (!baseArg || !candidateArg || process.argv.includes("--help")) {
    usage();
    process.exit(baseArg && candidateArg ? 0 : 1);
  }

  const basePath = resolve(baseArg);
  const candidatePath = resolve(candidateArg);
  const baseReport = readReport(basePath);
  const candidateReport = readReport(candidatePath);
  const base = firstRun(baseReport, "base");
  const candidate = firstRun(candidateReport, "candidate");
  const baseTexts = reportTexts(base);
  const candidateTexts = reportTexts(candidate);
  const maxLen = Math.max(baseTexts.length, candidateTexts.length);
  const diffs: Array<{ index: number; base: string; candidate: string }> = [];
  for (let index = 0; index < maxLen; index += 1) {
    const baseText = baseTexts[index] ?? "";
    const candidateText = candidateTexts[index] ?? "";
    if (baseText !== candidateText) {
      diffs.push({ index, base: baseText, candidate: candidateText });
    }
  }

  const summary = {
    base: {
      path: basePath,
      coldTotalMs: round(base.totalMs),
      warmTotalMs: round(baseReport.modes[0]?.warmMedian.totalMs ?? 0),
      ocrMs: round(base.ocrSummary.stageMs),
      sourceCharCount: base.sourceCharCount,
      textCount: baseTexts.length,
      paddle: base.ocrSummary.paddle,
    },
    candidate: {
      path: candidatePath,
      coldTotalMs: round(candidate.totalMs),
      warmTotalMs: round(candidateReport.modes[0]?.warmMedian.totalMs ?? 0),
      ocrMs: round(candidate.ocrSummary.stageMs),
      sourceCharCount: candidate.sourceCharCount,
      textCount: candidateTexts.length,
      paddle: candidate.ocrSummary.paddle,
    },
    textDiffCount: diffs.length,
    diffs,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
