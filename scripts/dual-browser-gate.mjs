import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const defaultConfigPath = resolve(
  root,
  '.github/dual-browser-gate-paths.json',
);
const levels = [
  'base',
  'extension_artifacts',
  'execution_conformance',
];
const levelRank = new Map(levels.map((level, index) => [level, index]));

function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function escapeRegexCharacter(character) {
  return /[\\^$.*+?()[\]{}|]/u.test(character)
    ? `\\${character}`
    : character;
}

function compileGlob(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegexCharacter(character);
    }
  }
  return new RegExp(`${source}$`, 'u');
}

function assertConfig(config) {
  if (config?.version !== 1) {
    throw new Error(
      `Unsupported dual-browser gate config version: ${String(config?.version)}`,
    );
  }
  if (!levelRank.has(config.unknownLevel)) {
    throw new Error(
      `Invalid unknown dual-browser gate level: ${String(config.unknownLevel)}`,
    );
  }
  if (!Array.isArray(config.rules) || config.rules.length === 0) {
    throw new Error('Dual-browser gate config must declare path rules.');
  }
  for (const rule of config.rules) {
    if (
      !levelRank.has(rule?.level)
      || !Array.isArray(rule.patterns)
      || rule.patterns.length === 0
      || rule.patterns.some(
        (pattern) => typeof pattern !== 'string' || pattern.length === 0,
      )
    ) {
      throw new Error(
        `Invalid dual-browser gate rule: ${JSON.stringify(rule)}`,
      );
    }
  }
}

export function loadDualBrowserGateConfig(configPath = defaultConfigPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assertConfig(config);
  return config;
}

function classifyPath(path, config) {
  const normalizedPath = normalizePath(path);
  let requiredLevel;
  for (const rule of config.rules) {
    if (
      rule.patterns.some(
        (pattern) => compileGlob(pattern).test(normalizedPath),
      )
      && (
        requiredLevel === undefined
        || levelRank.get(rule.level) > levelRank.get(requiredLevel)
      )
    ) {
      requiredLevel = rule.level;
    }
  }
  return requiredLevel ?? config.unknownLevel;
}

export function classifyDualBrowserGatePaths(paths, config) {
  const requiredLevel = paths.length === 0
    ? config.unknownLevel
    : paths.reduce((highestLevel, path) => {
      const pathLevel = classifyPath(path, config);
      return levelRank.get(pathLevel) > levelRank.get(highestLevel)
        ? pathLevel
        : highestLevel;
    }, 'base');
  const requiredRank = levelRank.get(requiredLevel);
  return {
    base: true,
    extensionArtifacts:
      requiredRank >= levelRank.get('extension_artifacts'),
    executionConformance:
      requiredRank >= levelRank.get('execution_conformance'),
  };
}

function isAllZeroSha(sha) {
  return typeof sha === 'string' && /^0+$/u.test(sha);
}

function runGitPathCommand(argumentsList, repositoryRoot = root) {
  return execFileSync('git', argumentsList, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split(/\r?\n/u)
    .filter(Boolean);
}

function listTrackedPaths(repositoryRoot = root) {
  return runGitPathCommand(['ls-files'], repositoryRoot);
}

export function collectChangedPaths({
  base,
  head,
  repositoryRoot = root,
}) {
  if (isAllZeroSha(base)) return listTrackedPaths(repositoryRoot);
  try {
    return runGitPathCommand([
      'diff',
      '--name-only',
      '--no-renames',
      '--diff-filter=ACDMRTUXB',
      `${base}...${head}`,
    ], repositoryRoot);
  } catch {
    console.warn(
      `Unable to compute changed paths for ${base}...${head}; classifying the full tracked tree.`,
    );
    return listTrackedPaths(repositoryRoot);
  }
}

function writeClassificationOutputs(path, classification) {
  const output = [
    `base=${String(classification.base)}`,
    `extension_artifacts=${String(classification.extensionArtifacts)}`,
    `execution_conformance=${String(classification.executionConformance)}`,
  ].join('\n');
  appendFileSync(path, `${output}\n`, 'utf8');
}

function requireSuccess(label, result) {
  if (result !== 'success') {
    throw new Error(
      `dual-browser-gate requires ${label} to be success; received ${String(result ?? 'missing')}`,
    );
  }
}

export function assertDualBrowserGate({
  expectedExtensionArtifacts,
  results,
}) {
  requireSuccess('classify', results.classify);
  requireSuccess('base', results.base);
  if (expectedExtensionArtifacts) {
    requireSuccess('extension-artifacts', results.extensionArtifacts);
  } else if (
    results.extensionArtifacts !== 'skipped'
    && results.extensionArtifacts !== 'success'
  ) {
    throw new Error(
      `dual-browser-gate expected extension-artifacts to be skipped or success; received ${String(results.extensionArtifacts ?? 'missing')}`,
    );
  }
}

function readOption(argumentsList, option) {
  const index = argumentsList.indexOf(option);
  return index === -1 ? undefined : argumentsList[index + 1];
}

function requireOption(argumentsList, option) {
  const value = readOption(argumentsList, option);
  if (!value) throw new Error(`${option} is required`);
  return value;
}

function parseBooleanOption(argumentsList, option) {
  const value = requireOption(argumentsList, option);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${option} must be true or false`);
}

function runCli(argumentsList) {
  const command = argumentsList[0];
  if (command === 'classify') {
    const base = requireOption(argumentsList, '--base');
    const head = requireOption(argumentsList, '--head');
    const config = loadDualBrowserGateConfig(
      readOption(argumentsList, '--config') ?? defaultConfigPath,
    );
    const paths = collectChangedPaths({ base, head });
    const classification = classifyDualBrowserGatePaths(paths, config);
    const githubOutput = readOption(argumentsList, '--github-output');
    if (githubOutput) {
      writeClassificationOutputs(githubOutput, classification);
    }
    console.log(JSON.stringify({ paths, ...classification }, null, 2));
    return;
  }
  if (command === 'aggregate') {
    assertDualBrowserGate({
      expectedExtensionArtifacts: parseBooleanOption(
        argumentsList,
        '--expected-extension-artifacts',
      ),
      results: {
        classify: readOption(argumentsList, '--classify-result'),
        base: readOption(argumentsList, '--base-result'),
        extensionArtifacts: readOption(
          argumentsList,
          '--extension-artifacts-result',
        ),
      },
    });
    console.log('dual-browser-gate passed all required evidence.');
    return;
  }
  throw new Error(`Unsupported dual-browser gate command: ${String(command)}`);
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli(process.argv.slice(2));
}
