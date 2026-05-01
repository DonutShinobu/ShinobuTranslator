import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { BenchConfig, BenchmarkSummary } from "./types";

const ROOT = resolve(import.meta.dirname, "../..");

function main(): void {
  const configRaw = readFileSync(join(ROOT, "benchmark/bench.config.json"), "utf-8");
  const config: BenchConfig = JSON.parse(configRaw);

  const updateBaseline = process.argv.includes("--update-baseline");
  const baselinePath = join(ROOT, "benchmark/baseline.json");

  const reportsDir = join(ROOT, config.reportsDir);
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
    const baseline = {
      generatedAt: current.generatedAt,
      avgCompositeScore: current.avgCompositeScore,
      avgColumnIouMean: current.avgColumnIouMean,
      avgFontSizeError: current.avgFontSizeError,
      avgColumnDxNorm: current.avgColumnDxNorm,
      avgCharDyNorm: current.avgCharDyNorm,
      columnCountMatchRate: current.columnCountMatchRate,
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
    console.log("Baseline updated.");
    return;
  }

  if (!existsSync(baselinePath)) {
    console.log("No baseline found. Run with --update-baseline to create one.");
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
  const threshold = config.regressionThreshold;

  const metrics: Array<{ name: string; baseline: number; current: number; higherIsBetter: boolean }> = [
    { name: "Composite Score", baseline: baseline.avgCompositeScore, current: current.avgCompositeScore, higherIsBetter: true },
    { name: "Column IoU", baseline: baseline.avgColumnIouMean, current: current.avgColumnIouMean, higherIsBetter: true },
    { name: "Font Size Error", baseline: baseline.avgFontSizeError, current: current.avgFontSizeError, higherIsBetter: false },
    { name: "Column Dx Norm", baseline: baseline.avgColumnDxNorm, current: current.avgColumnDxNorm, higherIsBetter: false },
    { name: "Char Dy Norm", baseline: baseline.avgCharDyNorm, current: current.avgCharDyNorm, higherIsBetter: false },
    { name: "Col Count Match", baseline: baseline.columnCountMatchRate, current: current.columnCountMatchRate, higherIsBetter: true },
  ];

  let hasRegression = false;
  for (const m of metrics) {
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
