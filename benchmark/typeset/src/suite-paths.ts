import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { BenchConfig } from "./types";

const rootDir = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const configPath = join(rootDir, "benchmark/typeset/bench.config.json");

export type TypesetSuitePaths = {
  suiteDir?: string;
  imagesDir: string;
  fixturesDir: string;
  reportsDir: string;
  baselinePath: string;
};

export type ParseTypesetSuiteOptions = {
  fixtureOutputAlias?: boolean;
};

export type ParsedTypesetSuiteArgs = {
  paths: TypesetSuitePaths;
  remainingArgs: string[];
};

function loadConfig(): BenchConfig {
  return JSON.parse(readFileSync(configPath, "utf-8")) as BenchConfig;
}

function resolveCliPath(path: string): string {
  return resolve(rootDir, path);
}

export function resolveTypesetBenchmarkPath(path: string): string {
  return resolveCliPath(path);
}

function readPathOption(
  args: string[],
  index: number,
  optionName: string,
): { matched: false } | { matched: true; value: string; consumed: number } {
  const arg = args[index];
  if (arg === optionName) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${optionName} requires a path.`);
    }
    return { matched: true, value, consumed: 2 };
  }
  const prefix = `${optionName}=`;
  if (arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length);
    if (!value) throw new Error(`${optionName} requires a path.`);
    return { matched: true, value, consumed: 1 };
  }
  return { matched: false };
}

export function parseTypesetSuiteArgs(
  args: string[],
  options: ParseTypesetSuiteOptions = {},
): ParsedTypesetSuiteArgs {
  let suiteDirValue: string | undefined;
  let imagesDirValue: string | undefined;
  let fixturesDirValue: string | undefined;
  let reportsDirValue: string | undefined;
  const remainingArgs: string[] = [];

  for (let index = 0; index < args.length;) {
    const optionNames = [
      "--suite-dir",
      "--images-dir",
      "--fixtures-dir",
      "--reports-dir",
      ...(options.fixtureOutputAlias ? ["--out-dir"] : []),
    ];
    let matched = false;
    for (const optionName of optionNames) {
      const result = readPathOption(args, index, optionName);
      if (!result.matched) continue;
      if (optionName === "--suite-dir") suiteDirValue = result.value;
      if (optionName === "--images-dir") imagesDirValue = result.value;
      if (optionName === "--fixtures-dir" || optionName === "--out-dir") {
        fixturesDirValue = result.value;
      }
      if (optionName === "--reports-dir") reportsDirValue = result.value;
      index += result.consumed;
      matched = true;
      break;
    }
    if (matched) continue;
    remainingArgs.push(args[index]);
    index += 1;
  }

  const config = loadConfig();
  const suiteDir = suiteDirValue ? resolveCliPath(suiteDirValue) : undefined;
  const imagesDir = resolveCliPath(
    imagesDirValue ?? (suiteDir ? join(suiteDir, "images") : config.imagesDir),
  );
  const fixturesDir = resolveCliPath(
    fixturesDirValue ?? (suiteDir ? join(suiteDir, "fixtures") : config.fixturesDir),
  );
  const reportsDir = resolveCliPath(
    reportsDirValue ?? (suiteDir ? join(suiteDir, "reports") : config.reportsDir),
  );

  return {
    paths: {
      suiteDir,
      imagesDir,
      fixturesDir,
      reportsDir,
      baselinePath: suiteDir
        ? join(suiteDir, "baseline.json")
        : join(rootDir, "benchmark/typeset/baseline.json"),
    },
    remainingArgs,
  };
}
