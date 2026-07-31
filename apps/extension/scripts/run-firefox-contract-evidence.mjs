#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadFirefoxCapabilityMatrix } from './firefox-capability-matrix.mjs';
import { writeContractReceipt } from './firefox-capability-receipt.mjs';

const outputOption = process.argv.indexOf('--output-dir');
const outputDirectory = resolve(
  outputOption === -1
    ? 'artifacts/firefox-capability-evidence/contracts'
    : process.argv[outputOption + 1] ?? '',
);
mkdirSync(outputDirectory, { recursive: true });

const matrix = loadFirefoxCapabilityMatrix();
const tests = [...new Set(Object.values(matrix.traceability).flatMap(
  (trace) => trace.tests,
).filter((path) => path.endsWith('.test.ts')).concat([
  'tests/extension/firefoxCapabilityMatrix.test.ts',
  'tests/extension/capabilities/extensionContracts.test.ts',
]))];
const reportPath = resolve(outputDirectory, 'contracts.vitest.json');
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(executable, [
  'vitest',
  'run',
  ...tests,
  '--reporter=json',
  `--outputFile=${reportPath}`,
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: 'inherit',
});
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  const report = JSON.parse(await import('node:fs/promises').then(
    ({ readFile }) => readFile(reportPath, 'utf8'),
  ));
  const normalizedPath = (value) => value.replaceAll('\\', '/');
  const passedFiles = new Set(report.testResults
    .filter((testResult) => testResult.assertionResults.every(
      (assertion) => assertion.status === 'passed',
    ))
    .map((testResult) => normalizedPath(testResult.name)));
  const passedAssertions = new Set(report.testResults.flatMap(
    (testResult) => testResult.assertionResults
      .filter((assertion) => assertion.status === 'passed')
      .map((assertion) => assertion.fullName),
  ));
  const observedForLayer = (layer) => [...new Set(matrix.capabilities.flatMap(
    (capability) => {
      const contractTests = matrix.traceability[capability.id].tests
        .filter((path) => path.endsWith('.test.ts'));
      const allTestsPassed = contractTests.length > 0 && contractTests.every(
        (path) => [...passedFiles].some(
          (passedPath) => passedPath.endsWith(normalizedPath(path)),
        ),
      );
      return allTestsPassed ? capability.evidence[layer] : [];
    },
  ))];
  const supplementalAssertions = [...passedAssertions].filter((name) => (
    name.startsWith('Firefox 23-capability parity matrix blocks ')
    || name.startsWith('Firefox 23-capability parity matrix keeps ')
    || name.startsWith('extension capability contracts ')
  ));
  const prohibitedBehaviorChecks = matrix.prohibitedBehaviors.map((id) => ({
    id,
    status: 'fail',
    evidence: [
      'pending:dual-browser-behavior-probe#58',
      ...supplementalAssertions,
    ].join(' + '),
  }));
  const inventory = await writeContractReceipt({
    layer: 'inventory',
    testReportPath: reportPath,
    outputPath: resolve(outputDirectory, 'inventory.receipt.json'),
    repositoryRoot: process.cwd(),
    observedEvidence: observedForLayer('inventory'),
  });
  const adapter = await writeContractReceipt({
    layer: 'adapterContract',
    testReportPath: reportPath,
    outputPath: resolve(outputDirectory, 'adapter-contract.receipt.json'),
    repositoryRoot: process.cwd(),
    prohibitedBehaviorChecks,
    observedEvidence: observedForLayer('adapterContract'),
  });
  console.log(JSON.stringify({
    reportPath,
    receipts: {
      inventory: inventory.reference,
      adapterContract: adapter.reference,
    },
  }, null, 2));
}
