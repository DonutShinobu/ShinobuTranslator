import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { BenchConfig, BenchmarkSummary } from "./types";
import { parseTypesetSuiteArgs } from "./suite-paths";
import {
  buildBaselineComparisons,
  buildTypesetBaseline,
  type TypesetBaseline,
} from "./baseline";

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");

function main(): void {
  const configRaw = readFileSync(join(ROOT, "benchmark/typeset/bench.config.json"), "utf-8");
  const config: BenchConfig = JSON.parse(configRaw);

  const parsed = parseTypesetSuiteArgs(process.argv.slice(2));
  const updateBaseline = parsed.remainingArgs.includes("--update-baseline");
  const unknownOption = parsed.remainingArgs.find((arg) => arg !== "--update-baseline");
  if (unknownOption) {
    console.error(`Unknown option: ${unknownOption}`);
    process.exit(1);
  }
  const baselinePath = parsed.paths.baselinePath;

  const reportsDir = parsed.paths.reportsDir;
  if (!existsSync(reportsDir)) {
    console.error("No reports directory. Run npm run bench first.");
    process.exit(1);
  }
  const dirs = readdirSync(reportsDir)
    .filter((d: string) => existsSync(join(reportsDir, d, "summary.json")))
    .sort()
    .reverse();
  if (dirs.length === 0) {
    console.error("No report found. Run npm run bench first.");
    process.exit(1);
  }
  const latestDir = join(reportsDir, dirs[0]);
  const current: BenchmarkSummary = JSON.parse(
    readFileSync(join(latestDir, "summary.json"), "utf-8"),
  );

  if (updateBaseline) {
    const baseline = buildTypesetBaseline(current);
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
    console.log("Baseline updated.");
    return;
  }

  if (!existsSync(baselinePath)) {
    console.log("No baseline found. Run with --update-baseline to create one.");
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as TypesetBaseline;
  const threshold = config.regressionThreshold;
  const comparison = buildBaselineComparisons(baseline, current);
  if (comparison.horizontalStatus === "missing-baseline") {
    console.log("Horizontal baseline not established; horizontal regression checks skipped.");
  }
  if (comparison.horizontalStatus === "missing-current") {
    console.error("Baseline expects horizontal regions, but the current report has no scored horizontal regions. Check suite and fixtures.");
    process.exit(1);
  }

  let hasRegression = false;
  for (const m of comparison.metrics) {
    const diff = m.current - m.baseline;
    const relDiff = m.baseline !== 0 ? Math.abs(diff / m.baseline) : Math.abs(diff);
    const improved = m.higherIsBetter ? diff > 0 : diff < 0;
    const regressed = m.higherIsBetter ? diff < 0 : diff > 0;
    const symbol = regressed && relDiff > threshold
      ? "X"
      : improved && relDiff > threshold
        ? "+"
        : "=";
    if (regressed && relDiff > threshold) hasRegression = true;
    console.log(
      `${symbol} ${m.name}: ${m.baseline.toFixed(4)} -> ${m.current.toFixed(4)} (${diff >= 0 ? "+" : ""}${diff.toFixed(4)})`,
    );
  }

  if (hasRegression) {
    console.log("\nRegressions detected (> " + (threshold * 100) + "% threshold)");
    process.exit(1);
  } else {
    console.log("\nNo regressions.");
  }
}

main();
