import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { assessFixtureSourceGeometry, type SourceGeometryStatus } from "./source-geometry";
import type { BenchConfig, Fixture } from "./types";

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG_PATH = join(ROOT, "benchmark/typeset/bench.config.json");

const STATUS_VALUES: SourceGeometryStatus[] = [
  "usable",
  "non_vertical",
  "empty_source_text",
  "column_count_mismatch",
  "text_mismatch",
  "spatial_order_mismatch",
];

type AuditOptions = {
  fixturesDir: string;
  strict: boolean;
};

type AuditCounts = {
  totalRegions: number;
  cleanRegions: number;
  nonCleanRegions: number;
  usableRegions: number;
  rejectedRegions: number;
  statuses: Record<SourceGeometryStatus, number>;
};

function createStatusCounts(): Record<SourceGeometryStatus, number> {
  return Object.fromEntries(STATUS_VALUES.map((status) => [status, 0])) as Record<SourceGeometryStatus, number>;
}

function createAuditCounts(): AuditCounts {
  return {
    totalRegions: 0,
    cleanRegions: 0,
    nonCleanRegions: 0,
    usableRegions: 0,
    rejectedRegions: 0,
    statuses: createStatusCounts(),
  };
}

function loadConfig(): BenchConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as BenchConfig;
}

function defaultFixturesDir(): string {
  const config = loadConfig();
  return resolve(ROOT, config.fixturesDir);
}

function parseArgs(args: string[]): AuditOptions {
  let fixturesDir = defaultFixturesDir();
  let sawFixtureDir = false;
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--fixtures-dir") {
      const dir = args[i + 1];
      if (!dir) {
        console.error("--fixtures-dir requires a path.");
        process.exit(1);
      }
      fixturesDir = resolve(ROOT, dir);
      sawFixtureDir = true;
      i++;
      continue;
    }
    if (arg.startsWith("--fixtures-dir=")) {
      fixturesDir = resolve(ROOT, arg.slice("--fixtures-dir=".length));
      sawFixtureDir = true;
      continue;
    }
    if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
    if (sawFixtureDir) {
      console.error(`Unexpected extra fixtures directory: ${arg}`);
      process.exit(1);
    }
    fixturesDir = resolve(ROOT, arg);
    sawFixtureDir = true;
  }

  return { fixturesDir, strict };
}

function addCounts(target: AuditCounts, source: AuditCounts): void {
  target.totalRegions += source.totalRegions;
  target.cleanRegions += source.cleanRegions;
  target.nonCleanRegions += source.nonCleanRegions;
  target.usableRegions += source.usableRegions;
  target.rejectedRegions += source.rejectedRegions;
  for (const status of STATUS_VALUES) {
    target.statuses[status] += source.statuses[status];
  }
}

function auditFixture(fixture: Fixture): AuditCounts {
  const counts = createAuditCounts();

  for (const region of fixture.regions) {
    const assessment = assessFixtureSourceGeometry(region);
    counts.totalRegions++;
    counts.statuses[assessment.status]++;
    if (assessment.status === "usable") {
      counts.cleanRegions++;
    } else {
      counts.nonCleanRegions++;
    }
    if (assessment.usable) {
      counts.usableRegions++;
    } else {
      counts.rejectedRegions++;
    }
  }

  return counts;
}

function formatProblemCounts(statuses: Record<SourceGeometryStatus, number>): string {
  return STATUS_VALUES
    .filter((status) => status !== "usable")
    .filter((status) => statuses[status] > 0)
    .map((status) => `${status}=${statuses[status]}`)
    .join(" ");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.fixturesDir)) {
    console.error(`Fixtures directory not found: ${options.fixturesDir}`);
    process.exit(1);
  }

  const fixtureFiles = readdirSync(options.fixturesDir)
    .filter((file) => file.endsWith(".fixture.json"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (fixtureFiles.length === 0) {
    console.error(`No fixture files found in ${options.fixturesDir}`);
    process.exit(1);
  }

  const summary = createAuditCounts();
  console.log(`Fixture audit: ${options.fixturesDir}`);

  for (const file of fixtureFiles) {
    const fixturePath = join(options.fixturesDir, file);
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Fixture;
    const counts = auditFixture(fixture);
    addCounts(summary, counts);
    const problems = formatProblemCounts(counts.statuses);
    console.log(
      `${file}: total=${counts.totalRegions} clean=${counts.cleanRegions} ` +
      `usable=${counts.usableRegions} rejected=${counts.rejectedRegions} ` +
      `problems=${problems || "none"}`,
    );
  }

  console.log(
    `Summary: files=${fixtureFiles.length} total=${summary.totalRegions} ` +
    `clean=${summary.cleanRegions} nonClean=${summary.nonCleanRegions} ` +
    `usable=${summary.usableRegions} rejected=${summary.rejectedRegions}`,
  );
  console.log(`Problems: ${formatProblemCounts(summary.statuses) || "none"}`);

  if (options.strict && summary.nonCleanRegions > 0) {
    console.error(`Strict fixture audit failed: ${summary.nonCleanRegions} non-clean region(s).`);
    process.exitCode = 1;
    return;
  }

  if (options.strict) {
    console.log("Strict fixture audit passed.");
  }
}

main();
