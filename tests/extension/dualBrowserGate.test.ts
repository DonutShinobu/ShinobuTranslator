import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDualBrowserGate,
  classifyDualBrowserGatePaths,
  collectChangedPaths,
  loadDualBrowserGateConfig,
} from '../../scripts/dual-browser-gate.mjs';
import {
  assertFirefoxLintResult,
  firefoxLintVendorExclusions,
} from '../../apps/extension/scripts/check-firefox-lint.mjs';

const root = process.cwd();
const workflowPath = resolve(root, '.github/workflows/ci.yml');

describe('dual-browser path classifier', () => {
  const config = loadDualBrowserGateConfig();

  it.each([
    {
      path: 'docs/adr/0002-extension-and-web-share-a-monorepo.md',
      expected: {
        base: true,
        extensionArtifacts: false,
        executionConformance: false,
      },
    },
    {
      path: 'apps/web/src/App.tsx',
      expected: {
        base: true,
        extensionArtifacts: false,
        executionConformance: false,
      },
    },
    {
      path: 'src/popup/index.ts',
      expected: {
        base: true,
        extensionArtifacts: true,
        executionConformance: false,
      },
    },
    {
      path: 'apps/extension/src/capabilities/chromeAdapter.ts',
      expected: {
        base: true,
        extensionArtifacts: true,
        executionConformance: true,
      },
    },
    {
      path: 'src/pipeline/orchestrator.ts',
      expected: {
        base: true,
        extensionArtifacts: true,
        executionConformance: true,
      },
    },
    {
      path: 'package-lock.json',
      expected: {
        base: true,
        extensionArtifacts: true,
        executionConformance: true,
      },
    },
  ])('classifies $path at its required evidence level', ({ path, expected }) => {
    expect(classifyDualBrowserGatePaths([path], config)).toEqual(expected);
  });

  it('fails closed to full conformance for an unknown path', () => {
    expect(classifyDualBrowserGatePaths(
      ['future-host/new-entry.ts'],
      config,
    )).toEqual({
      base: true,
      extensionArtifacts: true,
      executionConformance: true,
    });
  });

  it('falls back to the full tracked tree when a force-push base is unavailable', () => {
    const paths = collectChangedPaths({
      base: 'f'.repeat(40),
      head: 'HEAD',
    });

    expect(paths).toContain('.github/dual-browser-gate-paths.json');
    expect(classifyDualBrowserGatePaths(paths, config)).toEqual({
      base: true,
      extensionArtifacts: true,
      executionConformance: true,
    });
  });

  it(
    'classifies both sides when a sensitive path is renamed into a base-only area',
    () => {
      const repositoryRoot = mkdtempSync(
        join(tmpdir(), 'shinobu-dual-browser-gate-'),
      );
      try {
        execFileSync('git', ['init', '--quiet'], { cwd: repositoryRoot });
        execFileSync('git', ['config', 'user.name', 'Shinobu Test'], {
          cwd: repositoryRoot,
        });
        execFileSync('git', ['config', 'user.email', 'test@shinobu.invalid'], {
          cwd: repositoryRoot,
        });
        mkdirSync(resolve(repositoryRoot, 'src/pipeline'), { recursive: true });
        writeFileSync(
          resolve(repositoryRoot, 'src/pipeline/orchestrator.ts'),
          'export {};\n',
          'utf8',
        );
        execFileSync('git', ['add', '.'], { cwd: repositoryRoot });
        execFileSync('git', ['commit', '--quiet', '-m', 'add sensitive path'], {
          cwd: repositoryRoot,
        });
        const base = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repositoryRoot,
          encoding: 'utf8',
        }).trim();

        mkdirSync(resolve(repositoryRoot, 'docs'), { recursive: true });
        execFileSync(
          'git',
          ['mv', 'src/pipeline/orchestrator.ts', 'docs/orchestrator.ts'],
          { cwd: repositoryRoot },
        );
        execFileSync('git', ['commit', '--quiet', '-m', 'move to docs'], {
          cwd: repositoryRoot,
        });
        const head = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repositoryRoot,
          encoding: 'utf8',
        }).trim();

        const paths = collectChangedPaths({ base, head, repositoryRoot });

        expect(paths.sort()).toEqual([
          'docs/orchestrator.ts',
          'src/pipeline/orchestrator.ts',
        ]);
        expect(classifyDualBrowserGatePaths(paths, config)).toEqual({
          base: true,
          extensionArtifacts: true,
          executionConformance: true,
        });
      } finally {
        rmSync(repositoryRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it('uses the highest required level across all changed paths', () => {
    expect(classifyDualBrowserGatePaths(
      ['README.md', 'src/pipeline/orchestrator.ts'],
      config,
    )).toEqual({
      base: true,
      extensionArtifacts: true,
      executionConformance: true,
    });
  });
});

describe('dual-browser aggregate gate', () => {
  it('accepts an intentionally skipped artifact task for a base-only change', () => {
    expect(() => assertDualBrowserGate({
      expectedExtensionArtifacts: false,
      results: {
        classify: 'success',
        base: 'success',
        extensionArtifacts: 'skipped',
      },
    })).not.toThrow();
  });

  it.each([
    {
      label: 'missing',
      results: {
        classify: 'success',
        base: 'success',
      },
    },
    {
      label: 'incorrectly skipped',
      results: {
        classify: 'success',
        base: 'success',
        extensionArtifacts: 'skipped',
      },
    },
    {
      label: 'failed',
      results: {
        classify: 'success',
        base: 'success',
        extensionArtifacts: 'failure',
      },
    },
  ])('rejects a $label required artifact task', ({ results }) => {
    expect(() => assertDualBrowserGate({
      expectedExtensionArtifacts: true,
      results,
    })).toThrow(/extension-artifacts.*success/u);
  });

  it('rejects a failed base task', () => {
    expect(() => assertDualBrowserGate({
      expectedExtensionArtifacts: false,
      results: {
        classify: 'success',
        base: 'failure',
        extensionArtifacts: 'skipped',
      },
    })).toThrow(/base.*success/u);
  });
});

describe('Firefox lint fail-closed boundary', () => {
  it('accepts only a zero-finding successful web-ext result', () => {
    expect(() => assertFirefoxLintResult({
      status: 0,
      report: {
        summary: { errors: 0, warnings: 0 },
      },
      stderr: '',
    })).not.toThrow();
  });

  it.each([
    { status: 1, errors: 0, warnings: 1 },
    { status: 1, errors: 1, warnings: 0 },
    { status: null, errors: 0, warnings: 0 },
  ])('rejects non-success result %#', ({ status, errors, warnings }) => {
    expect(() => assertFirefoxLintResult({
      status,
      report: {
        summary: { errors, warnings },
        warnings: warnings > 0 ? [{ code: 'NEW_WARNING' }] : [],
      },
      stderr: 'failed',
    })).toThrow(/Firefox lint failed/u);
  });

  it('limits exclusions to release-checked generated vendor files', () => {
    expect(firefoxLintVendorExclusions).toEqual([
      'chunks/reactVendor.js',
      'chunks/ortVendor.js',
      'onnxWorker.js',
      'ort/ort-wasm-simd-threaded.asyncify.mjs',
      'ort/ort-wasm-simd-threaded.jsep.mjs',
    ]);
  });
});

describe('dual-browser GitHub merge gate', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  const eventPathFilterPattern = /\n {4}paths(?:-ignore)?:/u;

  it('always emits the same aggregate check for every candidate event', () => {
    expect(workflow).toContain('merge_group:');
    expect('on:\n  push:\n    paths:\n      - src/**\n')
      .toMatch(eventPathFilterPattern);
    expect(workflow).not.toMatch(eventPathFilterPattern);
    expect(workflow).toContain('name: dual-browser-gate');
    expect(workflow).toContain('if: always()');
  });

  it('runs repository sub-gates for base and dual-target artifact evidence', () => {
    expect(workflow).toContain('run: npm run check:base');
    expect(workflow).toContain('run: npm run check:extension-artifacts');
  });
});
