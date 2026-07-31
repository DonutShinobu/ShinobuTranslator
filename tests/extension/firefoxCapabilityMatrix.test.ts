import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createHash,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  assertFirefoxCapabilityMatrix,
  evaluateFirefoxCapabilityEvidence,
  loadFirefoxCapabilityMatrix,
  renderFirefoxCapabilitySummary,
  resolveRepositoryEvidenceIdentity,
  type FirefoxCapabilityEvidenceBundle,
  type FirefoxCapabilityEvidenceReceipt,
  type FirefoxCapabilityEvaluationOptions,
} from '../../apps/extension/scripts/firefox-capability-matrix.mjs';
import {
  resolveFirefoxSmokeEntryMode,
  resolveFirefoxSmokePackage,
} from '../../apps/extension/scripts/firefox-smoke-package.mjs';
import { writeFirefoxPackagedReceipt } from '../../apps/extension/scripts/firefox-capability-receipt.mjs';

const expectedCapabilityIds = [
  'entry.inline-image',
  'entry.screenshot',
  'entry.context-menu',
  'entry.commands',
  'entry.continuous',
  'settings.configuration',
  'ui.progress-errors-cancel',
  'pipeline.local-onnx',
  'network.image-download-headers',
  'translator.google-web',
  'llm.deepseek',
  'llm.gemini',
  'llm.glm',
  'llm.kimi',
  'llm.minimax',
  'llm.mimo',
  'llm.openai-api',
  'llm.custom',
  'image.gemini-api',
  'image.gemini-cookie',
  'auth.openai-oauth',
  'contract.permissions',
  'contract.event-page-recovery',
] as const;

const temporaryDirectories: string[] = [];
let sharedRepositoryRoot: string | undefined;
let sharedRepositoryFixtureRoot: string | undefined;
let sharedRepositoryIdentity: ReturnType<
  typeof resolveRepositoryEvidenceIdentity
> | undefined;

afterAll(() => {
  if (sharedRepositoryFixtureRoot) {
    rmSync(sharedRepositoryFixtureRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }).filter((path) => /\.[cm]?[jt]sx?$/u.test(path));
}

function readSources(paths: string[]): string {
  return paths.map((path) => readFileSync(path, 'utf8')).join('\n');
}

describe('Firefox 23-capability parity matrix', { timeout: 30_000 }, () => {
  it('is a complete machine-readable inventory with every evidence layer', () => {
    const matrix = loadFirefoxCapabilityMatrix();

    expect(() => assertFirefoxCapabilityMatrix(matrix)).not.toThrow();
    expect(matrix.capabilities.map((capability) => capability.id))
      .toEqual(expectedCapabilityIds);
    expect(matrix.capabilities).toHaveLength(23);
    expect(Object.keys(matrix.traceability)).toEqual(expectedCapabilityIds);

    for (const capability of matrix.capabilities) {
      expect(capability.userEntry.length).toBeGreaterThan(0);
      expect(capability.sharedContract.length).toBeGreaterThan(0);
      expect(capability.evidence).toMatchObject({
        inventory: expect.any(Array),
        adapterContract: expect.any(Array),
        firefox140Packaged: expect.any(Array),
        firefoxCurrentPackaged: expect.any(Array),
        chrome109Regression: expect.any(Array),
      });
      expect(capability.evidence.inventory.length).toBeGreaterThan(0);
      expect(capability.evidence.adapterContract.length).toBeGreaterThan(0);
      expect(capability.evidence.firefox140Packaged.length).toBeGreaterThan(0);
      expect(capability.evidence.firefoxCurrentPackaged.length)
        .toBeGreaterThan(0);
      expect(capability.evidence.chrome109Regression.length).toBeGreaterThan(0);
      expect(capability.scenarios.success.length).toBeGreaterThan(0);
      expect(capability.scenarios.criticalFailure.length).toBeGreaterThan(0);
      const requiredPackagedScenarios = [
        ...capability.scenarios.success,
        ...capability.scenarios.criticalFailure,
      ];
      expect(capability.evidence.firefox140Packaged)
        .toEqual(expect.arrayContaining(requiredPackagedScenarios));
      expect(capability.evidence.firefoxCurrentPackaged)
        .toEqual(expect.arrayContaining(requiredPackagedScenarios));
      const trace = matrix.traceability[capability.id];
      expect(trace.entry).not.toHaveLength(0);
      expect(trace.contract).not.toHaveLength(0);
      expect(trace.tests).not.toHaveLength(0);
      for (const path of [...trace.entry, ...trace.contract, ...trace.tests]) {
        expect(existsSync(resolve(path)), `missing traceability path ${path}`)
          .toBe(true);
      }
    }
  });

  it('blocks Firefox-only hidden product entries', () => {
    const sharedProductEntries = readSources([
      ...sourceFiles(resolve('src/popup')),
      ...sourceFiles(resolve('src/content')),
      resolve('src/shared/config.ts'),
    ]);
    expect(sharedProductEntries).not.toMatch(/\bfirefox\b/iu);
  });

  it('blocks provider silent fallback in runtime selection', () => {
    const providerRuntime = readSources([
      ...sourceFiles(resolve('src/translators')),
      ...sourceFiles(resolve('src/background/providers')),
    ]);
    expect(providerRuntime).not.toMatch(/\bfallback\b/iu);
    expect(providerRuntime).not.toMatch(
      /\b(?:llmProvider|provider)\s*=(?!=)/u,
    );
  });

  it('keeps the pipeline behind its package owner and migration seam', () => {
    const pipelineOwners = readSources([
      ...sourceFiles(resolve('packages/image-pipeline')),
      ...sourceFiles(resolve('src/pipeline')),
    ]);
    expect(pipelineOwners).not.toMatch(/\bfirefox\b/iu);
    const extensionSources = readSources(sourceFiles(resolve('apps/extension/src')));
    const declarations = extensionSources.match(
      /(?:class|function|const)\s+\w*Pipeline\w*/gu,
    ) ?? [];
    expect(declarations).toEqual([
      'function createTargetPipelineHostLifecycle',
      'function createTargetPipelineHostLifecycle',
      'function createChromePipelineHostLifecycle',
      'function createFirefoxPipelineHostLifecycle',
      'function createTargetPipelineHostComposition',
    ]);
  });

  it('keeps configuration behind the shared schema owner', () => {
    const sharedConfig = readSources([
      ...sourceFiles(resolve('packages/shared-config')),
      resolve('src/shared/config.ts'),
    ]);
    expect(sharedConfig).not.toMatch(/\bfirefox\b/iu);
    const extensionSources = readSources(sourceFiles(resolve('apps/extension/src')));
    expect(extensionSources).not.toMatch(
      /(?:class|function|const)\s+\w*Config(?:uration)?\w*/u,
    );
  });

  it('keeps product controllers out of the Firefox adapter workspace', () => {
    const controllers = readSources(sourceFiles(resolve('src/content/core')));
    expect(controllers).not.toMatch(/\bfirefox\b/iu);
    const extensionSources = readSources(sourceFiles(resolve('apps/extension/src')));
    expect(extensionSources).not.toMatch(
      /(?:class|function|const)\s+\w*Controller\w*/u,
    );
  });

  function passingEvidence(): {
    evidence: FirefoxCapabilityEvidenceBundle;
    options: FirefoxCapabilityEvaluationOptions;
    mutateReceipt: (
      layer: keyof FirefoxCapabilityEvidenceBundle['receipts'],
      mutate: (receipt: FirefoxCapabilityEvidenceReceipt) => void,
    ) => void;
    artifactPaths: { xpi: string; chromeZip: string };
  } {
    const matrix = loadFirefoxCapabilityMatrix();
    const coverage = Object.fromEntries(matrix.capabilities.map((capability) => [
      capability.id,
      capability.evidence,
    ]));
    if (!sharedRepositoryRoot) {
      sharedRepositoryFixtureRoot = mkdtempSync(
        resolve(tmpdir(), 'firefox-parity-repository-'),
      );
      sharedRepositoryRoot = resolve(
        sharedRepositoryFixtureRoot,
        'repository',
      );
      mkdirSync(resolve(sharedRepositoryRoot, 'apps/extension'), {
        recursive: true,
      });
      mkdirSync(resolve(sharedRepositoryRoot, 'packages/model-manifest'), {
        recursive: true,
      });
      writeFileSync(
        resolve(sharedRepositoryRoot, 'apps/extension/package.json'),
        '{"name":"@shinobu/extension","version":"0.8.1"}\n',
      );
      writeFileSync(resolve(sharedRepositoryRoot, 'package-lock.json'), '{}\n');
      writeFileSync(
        resolve(sharedRepositoryRoot, 'packages/model-manifest/manifest.json'),
        '{"version":"test"}\n',
      );
      execFileSync('git', ['init', '--quiet'], { cwd: sharedRepositoryRoot });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
        cwd: sharedRepositoryRoot,
      });
      execFileSync('git', ['config', 'user.name', 'Firefox matrix test'], {
        cwd: sharedRepositoryRoot,
      });
      execFileSync('git', ['add', '.'], { cwd: sharedRepositoryRoot });
      execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {
        cwd: sharedRepositoryRoot,
      });
      sharedRepositoryIdentity = resolveRepositoryEvidenceIdentity(
        sharedRepositoryRoot,
      );
    }
    const repositoryRoot = sharedRepositoryRoot;
    const identity = { ...sharedRepositoryIdentity! };
    const evidenceDirectory = mkdtempSync(
      resolve(tmpdir(), 'firefox-parity-evidence-'),
    );
    temporaryDirectories.push(evidenceDirectory);
    const xpiPath = resolve(evidenceDirectory, 'shinobu-translator.xpi');
    const chromeZipPath = resolve(evidenceDirectory, 'shinobu-translator.zip');
    writeFileSync(xpiPath, 'canonical-firefox-xpi');
    writeFileSync(chromeZipPath, 'canonical-chrome-zip');
    const currentFirefoxStableVersion = '142.0.1';
    const prohibitedBehaviorChecks = matrix.prohibitedBehaviors.map((id) => ({
      id,
      status: 'pass' as const,
      evidence: `architecture:${id}`,
    }));
    const observationsFor = (layerCoverage: Record<string, string[]>) => (
      [...new Set(Object.values(layerCoverage).flat())].map((id) => ({
        id,
        status: 'pass' as const,
      }))
    );
    const inventoryCoverage = Object.fromEntries(Object.entries(coverage).map(
      ([id, layerEvidence]) => [id, layerEvidence.inventory],
    ));
    const adapterCoverage = Object.fromEntries(Object.entries(coverage).map(
      ([id, layerEvidence]) => [id, layerEvidence.adapterContract],
    ));
    const firefox140Coverage = Object.fromEntries(Object.entries(coverage).map(
      ([id, layerEvidence]) => [id, layerEvidence.firefox140Packaged],
    ));
    const firefoxCurrentCoverage = Object.fromEntries(Object.entries(coverage).map(
      ([id, layerEvidence]) => [id, layerEvidence.firefoxCurrentPackaged],
    ));
    const chrome109Coverage = Object.fromEntries(Object.entries(coverage).map(
      ([id, layerEvidence]) => [id, layerEvidence.chrome109Regression],
    ));
    const receipts = {
      inventory: {
        schemaVersion: 1 as const,
        layer: 'inventory' as const,
        runner: 'vitest:firefox-capability-inventory',
        identity,
        status: 'pass' as const,
        coverage: inventoryCoverage,
        observations: observationsFor(inventoryCoverage),
      },
      adapterContract: {
        schemaVersion: 1 as const,
        layer: 'adapterContract' as const,
        runner: 'vitest:firefox-adapter-contract',
        identity,
        status: 'pass' as const,
        prohibitedBehaviorChecks,
        coverage: adapterCoverage,
        observations: observationsFor(adapterCoverage),
      },
      firefox140Packaged: {
        schemaVersion: 1 as const,
        layer: 'firefox140Packaged' as const,
        runner: 'webdriver:packaged-firefox-user-entry',
        identity,
        status: 'pass' as const,
        entryMode: 'packaged-user-entry' as const,
        browser: { name: 'firefox' as const, version: '140.0.4', channel: 'minimum' as const },
        artifact: {
          kind: 'xpi' as const,
          installation: 'packaged' as const,
          path: xpiPath,
          sha256: sha256(readFileSync(xpiPath)),
        },
        coverage: firefox140Coverage,
        observations: observationsFor(firefox140Coverage),
      },
      firefoxCurrentPackaged: {
        schemaVersion: 1 as const,
        layer: 'firefoxCurrentPackaged' as const,
        runner: 'webdriver:packaged-firefox-user-entry',
        identity,
        status: 'pass' as const,
        entryMode: 'packaged-user-entry' as const,
        browser: {
          name: 'firefox' as const,
          version: currentFirefoxStableVersion,
          channel: 'current-stable' as const,
        },
        artifact: {
          kind: 'xpi' as const,
          installation: 'signed' as const,
          path: xpiPath,
          sha256: sha256(readFileSync(xpiPath)),
        },
        coverage: firefoxCurrentCoverage,
        observations: observationsFor(firefoxCurrentCoverage),
      },
      chrome109Regression: {
        schemaVersion: 1 as const,
        layer: 'chrome109Regression' as const,
        runner: 'webdriver:chrome109-user-entry',
        identity,
        status: 'pass' as const,
        entryMode: 'packaged-user-entry' as const,
        browser: { name: 'chrome' as const, version: '109.0.5414.120', channel: 'minimum' as const },
        artifact: {
          kind: 'chrome-zip' as const,
          path: chromeZipPath,
          sha256: sha256(readFileSync(chromeZipPath)),
        },
        coverage: chrome109Coverage,
        observations: observationsFor(chrome109Coverage),
      },
    } satisfies Record<string, FirefoxCapabilityEvidenceReceipt>;
    const receiptReferences = Object.fromEntries(Object.entries(receipts).map(
      ([layer, receipt]) => {
        const path = resolve(evidenceDirectory, `${layer}.receipt.json`);
        const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
        writeFileSync(path, bytes);
        return [layer, { path, sha256: sha256(bytes) }];
      },
    )) as FirefoxCapabilityEvidenceBundle['receipts'];
    const evidence = {
      schemaVersion: 1,
      identity,
      receipts: receiptReferences,
    } satisfies FirefoxCapabilityEvidenceBundle;
    const options = {
      evidenceBaseDirectory: evidenceDirectory,
      repositoryRoot,
      currentFirefoxStableVersion,
    };
    const mutateReceipt = (
      layer: keyof FirefoxCapabilityEvidenceBundle['receipts'],
      mutate: (receipt: FirefoxCapabilityEvidenceReceipt) => void,
    ) => {
      const reference = evidence.receipts[layer];
      const receipt = JSON.parse(
        readFileSync(reference.path, 'utf8'),
      ) as FirefoxCapabilityEvidenceReceipt;
      mutate(receipt);
      const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
      writeFileSync(reference.path, bytes);
      reference.sha256 = sha256(bytes);
    };
    return {
      evidence,
      options,
      mutateReceipt,
      artifactPaths: { xpi: xpiPath, chromeZip: chromeZipPath },
    };
  }

  it('declares complete parity only when all 23 capabilities pass every layer', () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report).toMatchObject({
      conclusion: 'complete-parity',
      passedCapabilities: 23,
      totalCapabilities: 23,
      errors: [],
    });
    expect(report.capabilities.every((capability) => capability.status === 'pass'))
      .toBe(true);
    expect(renderFirefoxCapabilitySummary(report)).toContain(
      'Firefox complete capability parity: PASS (23/23)',
    );
  });

  it('fails closed when required browser evidence is missing', () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    fixture.mutateReceipt('firefoxCurrentPackaged', (receipt) => {
      receipt.coverage['llm.mimo'] = [];
    });

    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report.conclusion).toBe('incomplete');
    expect(report.passedCapabilities).toBe(22);
    expect(report.capabilities.find(({ id }) => id === 'llm.mimo')?.errors)
      .toContain(
        'firefoxCurrentPackaged is missing evidence provider.mimo.completed.',
      );
  });

  it.each([
    'firefox-only-hidden',
    'provider-silent-fallback',
    'parallel-pipeline',
    'parallel-config',
    'parallel-controller',
    'silent-no-op',
    'browser-message-control-flow',
  ])('fails closed when %s is detected', (prohibitedBehavior) => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    fixture.mutateReceipt('adapterContract', (receipt) => {
      const check = receipt.prohibitedBehaviorChecks?.find(
        ({ id }) => id === prohibitedBehavior,
      );
      if (!check) throw new Error(`missing ${prohibitedBehavior}`);
      check.status = 'fail';
    });

    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report.conclusion).toBe('incomplete');
    expect(report.errors).toContain(
      `Prohibited behavior check ${prohibitedBehavior} did not pass.`,
    );
  });

  it('rejects temporary Firefox installation as permission evidence', () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    fixture.mutateReceipt('firefox140Packaged', (receipt) => {
      if (!receipt.artifact || receipt.artifact.kind !== 'xpi') {
        throw new Error('missing XPI artifact');
      }
      receipt.artifact.installation = 'temporary';
    });

    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report.conclusion).toBe('incomplete');
    expect(report.errors).toContain(
      'firefox140Packaged permission evidence must use a packaged or signed XPI, not a temporary installation.',
    );
  });

  it('binds every receipt to the checked-out commit and canonical inputs', () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    fixture.evidence.identity.commit = 'a'.repeat(40);

    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report.conclusion).toBe('incomplete');
    expect(report.errors).toContain(
      'Evidence identity commit does not match the checked-out repository.',
    );
  });

  it('rejects evidence generated from a dirty tracked checkout', () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    writeFileSync(
      resolve(fixture.options.repositoryRoot!, 'package-lock.json'),
      '{"dirty":true}\n',
    );

    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report.conclusion).toBe('incomplete');
    expect(report.errors).toContain(
      'Firefox capability evidence requires a clean tracked checkout.',
    );
    writeFileSync(
      resolve(fixture.options.repositoryRoot!, 'package-lock.json'),
      '{}\n',
    );
  });

  it('rejects a receipt whose bytes no longer match its recorded digest', () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    writeFileSync(
      fixture.evidence.receipts.inventory.path,
      '{"status":"pass"}\n',
    );

    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report.conclusion).toBe('incomplete');
    expect(report.errors).toContain('inventory receipt SHA-256 does not match its bytes.');
  });

  it('rejects artifact evidence when the packaged bytes change', () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    writeFileSync(fixture.artifactPaths.xpi, 'different-xpi-bytes');

    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report.conclusion).toBe('incomplete');
    expect(report.errors).toContain(
      'firefox140Packaged artifact SHA-256 does not match its bytes.',
    );
  });

  it('requires current-stable evidence to match the externally resolved Mozilla channel', () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    fixture.mutateReceipt('firefoxCurrentPackaged', (receipt) => {
      if (!receipt.browser) throw new Error('missing browser');
      receipt.browser.version = '1.0.0';
    });

    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report.conclusion).toBe('incomplete');
    expect(report.errors).toContain(
      'firefoxCurrentPackaged version must equal externally resolved current stable 142.0.1.',
    );
  });

  it('rejects direct-port probes as packaged Firefox capability evidence', () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    fixture.mutateReceipt('firefox140Packaged', (receipt) => {
      receipt.entryMode = 'direct-port';
    });

    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report.conclusion).toBe('incomplete');
    expect(report.errors).toContain(
      'firefox140Packaged must exercise packaged user entries, not a direct runtime probe.',
    );
  });

  it('requires every browser coverage claim to have a passing runner observation', () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    fixture.mutateReceipt('firefox140Packaged', (receipt) => {
      receipt.observations = receipt.observations.filter(
        ({ id }) => id !== 'provider.deepseek.completed',
      );
    });

    const report = evaluateFirefoxCapabilityEvidence(
      matrix,
      fixture.evidence,
      fixture.options,
    );

    expect(report.conclusion).toBe('incomplete');
    expect(report.errors).toContain(
      'firefox140Packaged coverage provider.deepseek.completed has no passing runner observation.',
    );
  });

  it('requires the packaged Firefox smoke to use a persistent XPI install', async () => {
    const fixtureDirectory = mkdtempSync(
      resolve(tmpdir(), 'firefox-smoke-package-'),
    );
    temporaryDirectories.push(fixtureDirectory);
    const xpiPath = resolve(fixtureDirectory, 'shinobu-translator.xpi');

    await expect(resolveFirefoxSmokePackage({
      xpiPath,
      isAccessible: async () => true,
    })).resolves.toEqual({
      path: xpiPath,
      temporary: false,
    });

    await expect(resolveFirefoxSmokePackage({
      xpiPath: undefined,
      isAccessible: async () => true,
    })).rejects.toThrow(/FIREFOX_XPI/iu);
    await expect(resolveFirefoxSmokePackage({
      xpiPath: 'C:/artifacts/firefox-directory',
      isAccessible: async () => true,
    })).rejects.toThrow(/\.xpi/iu);
  });

  it('uses real packaged user entries on Firefox 140 and every newer version', () => {
    expect(resolveFirefoxSmokeEntryMode('140.0.4'))
      .toBe('packaged-user-entry');
    expect(resolveFirefoxSmokeEntryMode('151.0'))
      .toBe('packaged-user-entry');
    expect(() => resolveFirefoxSmokeEntryMode('139.0.4'))
      .toThrow(/Firefox 140\+/u);
  });

  it('lets the packaged WebDriver runner emit a verified full-layer receipt', async () => {
    const matrix = loadFirefoxCapabilityMatrix();
    const fixture = passingEvidence();
    const outputPath = resolve(
      fixture.options.evidenceBaseDirectory!,
      'webdriver.receipt.json',
    );

    const written = await writeFirefoxPackagedReceipt({
      layer: 'firefox140Packaged',
      browserVersion: '140.0.4',
      artifactPath: fixture.artifactPaths.xpi,
      installation: 'packaged',
      outputPath,
      repositoryRoot: fixture.options.repositoryRoot!,
      observedEvidence: matrix.capabilities.flatMap(
        (capability) => capability.evidence.firefox140Packaged,
      ),
    });

    expect(written.receipt.runner)
      .toBe('webdriver:packaged-firefox-user-entry');
    expect(written.receipt.entryMode).toBe('packaged-user-entry');
    expect(written.receipt.observations.map(({ id }) => id))
      .toEqual(expect.arrayContaining(matrix.capabilities.flatMap(
        (capability) => capability.evidence.firefox140Packaged,
      )));
    expect(readFileSync(outputPath, 'utf8')).toContain(
      'provider.deepseek.completed',
    );
  });

  it('keeps a packaged runner receipt incomplete for unobserved scenarios', async () => {
    const fixture = passingEvidence();
    const outputPath = resolve(
      fixture.options.evidenceBaseDirectory!,
      'incomplete-webdriver.receipt.json',
    );

    const written = await writeFirefoxPackagedReceipt({
      layer: 'firefox140Packaged',
      browserVersion: '140.0.4',
      artifactPath: fixture.artifactPaths.xpi,
      installation: 'packaged',
      outputPath,
      repositoryRoot: fixture.options.repositoryRoot!,
      observedEvidence: ['provider.deepseek.completed'],
    });

    expect(written.receipt.status).toBe('fail');
    expect(written.receipt.observations).toEqual([
      { id: 'provider.deepseek.completed', status: 'pass' },
    ]);
    expect(JSON.parse(readFileSync(outputPath, 'utf8')).missingEvidence)
      .toContain('provider.gemini.completed');
  });
});
