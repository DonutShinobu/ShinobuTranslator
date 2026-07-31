import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  loadFirefoxCapabilityMatrix,
  resolveRepositoryEvidenceIdentity,
} from './firefox-capability-matrix.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requiredLayerEvidence(matrix, layer) {
  return [...new Set(matrix.capabilities.flatMap(
    (capability) => capability.evidence[layer],
  ))];
}

export async function writeFirefoxPackagedReceipt({
  layer,
  browserVersion,
  artifactPath,
  installation,
  outputPath,
  repositoryRoot,
  observedEvidence,
}) {
  if (!['firefox140Packaged', 'firefoxCurrentPackaged'].includes(layer)) {
    throw new Error(`Unsupported Firefox packaged evidence layer: ${layer}`);
  }
  const matrix = loadFirefoxCapabilityMatrix();
  const requiredEvidence = requiredLayerEvidence(matrix, layer);
  const observed = new Set(observedEvidence);
  const missingEvidence = requiredEvidence.filter((id) => !observed.has(id));
  const resolvedArtifactPath = resolve(artifactPath);
  const artifactBytes = await readFile(resolvedArtifactPath);
  const identity = resolveRepositoryEvidenceIdentity(repositoryRoot);
  const receipt = {
    schemaVersion: 1,
    layer,
    runner: 'webdriver:packaged-firefox-user-entry',
    identity,
    status: missingEvidence.length === 0 ? 'pass' : 'fail',
    entryMode: 'packaged-user-entry',
    browser: {
      name: 'firefox',
      version: browserVersion,
      channel: layer === 'firefox140Packaged'
        ? 'minimum'
        : 'current-stable',
    },
    artifact: {
      kind: 'xpi',
      installation,
      path: resolvedArtifactPath,
      sha256: sha256(artifactBytes),
    },
    coverage: Object.fromEntries(matrix.capabilities.map((capability) => [
      capability.id,
      capability.evidence[layer].filter((id) => observed.has(id)),
    ])),
    observations: requiredEvidence
      .filter((id) => observed.has(id))
      .map((id) => ({
      id,
      status: 'pass',
      })),
    missingEvidence,
  };
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(resolve(outputPath), bytes, 'utf8');
  return {
    receipt,
    reference: { path: resolve(outputPath), sha256: sha256(bytes) },
  };
}

export async function writeContractReceipt({
  layer,
  testReportPath,
  outputPath,
  repositoryRoot,
  prohibitedBehaviorChecks,
  observedEvidence,
}) {
  if (!['inventory', 'adapterContract'].includes(layer)) {
    throw new Error(`Unsupported contract evidence layer: ${layer}`);
  }
  const report = JSON.parse(await readFile(resolve(testReportPath), 'utf8'));
  if (report?.success !== true) {
    throw new Error(`${layer} Vitest report did not pass.`);
  }
  const matrix = loadFirefoxCapabilityMatrix();
  const requiredEvidence = requiredLayerEvidence(matrix, layer);
  const observed = new Set(observedEvidence);
  const missingEvidence = requiredEvidence.filter((id) => !observed.has(id));
  const receipt = {
    schemaVersion: 1,
    layer,
    runner: layer === 'inventory'
      ? 'vitest:firefox-capability-inventory'
      : 'vitest:firefox-adapter-contract',
    identity: resolveRepositoryEvidenceIdentity(repositoryRoot),
    status: missingEvidence.length === 0 ? 'pass' : 'fail',
    coverage: Object.fromEntries(matrix.capabilities.map((capability) => [
      capability.id,
      capability.evidence[layer].filter((id) => observed.has(id)),
    ])),
    observations: requiredEvidence
      .filter((id) => observed.has(id))
      .map((id) => ({ id, status: 'pass' })),
    missingEvidence,
    ...(layer === 'adapterContract' ? { prohibitedBehaviorChecks } : {}),
  };
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(resolve(outputPath), bytes, 'utf8');
  return {
    receipt,
    reference: { path: resolve(outputPath), sha256: sha256(bytes) },
  };
}
