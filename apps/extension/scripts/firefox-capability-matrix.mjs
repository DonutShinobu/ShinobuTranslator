#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const matrixPath = resolve(
  import.meta.dirname,
  '..',
  'firefox-capability-matrix.json',
);

const evidenceLayers = [
  'inventory',
  'adapterContract',
  'firefox140Packaged',
  'firefoxCurrentPackaged',
  'chrome109Regression',
];

const expectedReceiptRunners = {
  inventory: 'vitest:firefox-capability-inventory',
  adapterContract: 'vitest:firefox-adapter-contract',
  firefox140Packaged: 'webdriver:packaged-firefox-user-entry',
  firefoxCurrentPackaged: 'webdriver:packaged-firefox-user-entry',
  chrome109Regression: 'webdriver:chrome109-user-entry',
};

const requiredProhibitedBehaviors = [
  'firefox-only-hidden',
  'provider-silent-fallback',
  'parallel-pipeline',
  'parallel-config',
  'parallel-controller',
  'silent-no-op',
  'browser-message-control-flow',
];

const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readSha256(path) {
  return sha256(readFileSync(path));
}

export function resolveRepositoryEvidenceIdentity(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const status = execFileSync(
    'git',
    ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
    { cwd: root, encoding: 'utf8' },
  ).trim().split(/\r?\n/u);
  const commit = status.find((line) => line.startsWith('# branch.oid '))
    ?.slice('# branch.oid '.length);
  if (!commitPattern.test(commit ?? '')) {
    throw new Error('Firefox capability evidence requires a committed HEAD.');
  }
  if (status.some((line) => line.length > 0 && !line.startsWith('# '))) {
    throw new Error(
      'Firefox capability evidence requires a clean tracked checkout.',
    );
  }
  const extensionPackage = JSON.parse(readFileSync(
    resolve(root, 'apps/extension/package.json'),
    'utf8',
  ));
  return {
    commit,
    extensionVersion: extensionPackage.version,
    lockfileSha256: readSha256(resolve(root, 'package-lock.json')),
    modelManifestSha256: readSha256(resolve(
      root,
      'packages/model-manifest/manifest.json',
    )),
  };
}

function assertNonEmptyString(value, location) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${location} must be a non-empty string.`);
  }
}

function assertNonEmptyStringArray(value, location) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new Error(`${location} must be a non-empty string array.`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${location} must not contain duplicate evidence ids.`);
  }
}

export function assertFirefoxCapabilityMatrix(matrix) {
  if (matrix?.schemaVersion !== 1) {
    throw new Error('Firefox capability matrix schemaVersion must be 1.');
  }
  if (!Array.isArray(matrix.capabilities) || matrix.capabilities.length !== 23) {
    throw new Error('Firefox capability matrix must contain exactly 23 capabilities.');
  }
  assertNonEmptyStringArray(
    matrix.prohibitedBehaviors,
    'prohibitedBehaviors',
  );
  if (
    matrix.prohibitedBehaviors.length !== requiredProhibitedBehaviors.length
    || matrix.prohibitedBehaviors.some(
      (behavior, index) => behavior !== requiredProhibitedBehaviors[index],
    )
  ) {
    throw new Error(
      'Firefox capability matrix must preserve every prohibited degradation check.',
    );
  }
  if (!matrix.traceability || typeof matrix.traceability !== 'object') {
    throw new Error('Firefox capability matrix traceability map is required.');
  }
  const ids = new Set();
  for (const [index, capability] of matrix.capabilities.entries()) {
    const location = `capabilities[${index}]`;
    assertNonEmptyString(capability?.id, `${location}.id`);
    if (ids.has(capability.id)) {
      throw new Error(`Duplicate Firefox capability id: ${capability.id}.`);
    }
    ids.add(capability.id);
    const trace = matrix.traceability[capability.id];
    for (const field of ['entry', 'contract', 'tests']) {
      assertNonEmptyStringArray(
        trace?.[field],
        `traceability.${capability.id}.${field}`,
      );
    }
    assertNonEmptyString(capability.title, `${location}.title`);
    assertNonEmptyString(capability.userEntry, `${location}.userEntry`);
    assertNonEmptyString(capability.sharedContract, `${location}.sharedContract`);
    assertNonEmptyStringArray(
      capability.scenarios?.success,
      `${location}.scenarios.success`,
    );
    assertNonEmptyStringArray(
      capability.scenarios?.criticalFailure,
      `${location}.scenarios.criticalFailure`,
    );
    for (const layer of evidenceLayers) {
      assertNonEmptyStringArray(
        capability.evidence?.[layer],
        `${location}.evidence.${layer}`,
      );
    }
    const requiredFirefoxScenarios = [
      ...capability.scenarios.success,
      ...capability.scenarios.criticalFailure,
    ];
    for (const layer of ['firefox140Packaged', 'firefoxCurrentPackaged']) {
      const missing = missingEvidence(
        requiredFirefoxScenarios,
        capability.evidence[layer],
      );
      if (missing.length > 0) {
        throw new Error(
          `${location}.evidence.${layer} does not cover required scenario ${missing[0]}.`,
        );
      }
    }
  }
  for (const traceId of Object.keys(matrix.traceability)) {
    if (!ids.has(traceId)) {
      throw new Error(`Traceability references unknown capability ${traceId}.`);
    }
  }
  return matrix;
}

export function loadFirefoxCapabilityMatrix() {
  return assertFirefoxCapabilityMatrix(JSON.parse(readFileSync(matrixPath, 'utf8')));
}

function missingEvidence(required, observed) {
  const observedSet = new Set(Array.isArray(observed) ? observed : []);
  return required.filter((id) => !observedSet.has(id));
}

function browserMajor(version) {
  return Number.parseInt(String(version).split('.')[0] ?? '', 10);
}

function validateIdentity(identity, trustedIdentity, errors) {
  if (!commitPattern.test(identity?.commit ?? '')) {
    errors.push('Evidence identity commit must be a full lowercase Git SHA.');
  }
  assertNonEmptyStringOrError(
    identity?.extensionVersion,
    'Evidence identity extensionVersion',
    errors,
  );
  for (const field of ['lockfileSha256', 'modelManifestSha256']) {
    if (!sha256Pattern.test(identity?.[field] ?? '')) {
      errors.push(`Evidence identity ${field} must be a lowercase SHA-256.`);
    }
  }
  const labels = {
    commit: 'commit',
    extensionVersion: 'extension version',
    lockfileSha256: 'lockfile SHA-256',
    modelManifestSha256: 'model manifest SHA-256',
  };
  for (const [field, label] of Object.entries(labels)) {
    if (trustedIdentity && identity?.[field] !== trustedIdentity[field]) {
      errors.push(
        `Evidence identity ${label} does not match the checked-out repository.`,
      );
    }
  }
}

function assertNonEmptyStringOrError(value, location, errors) {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${location} must be a non-empty string.`);
  }
}

function validateBrowserLayer(layerName, layer, options, errors) {
  if (layer?.status !== 'pass') {
    errors.push(`${layerName} did not pass.`);
  }
  if (layerName === 'firefox140Packaged') {
    if (
      layer?.browser?.name !== 'firefox'
      || layer.browser.channel !== 'minimum'
      || browserMajor(layer.browser.version) !== 140
    ) {
      errors.push('firefox140Packaged must run Firefox 140 on the minimum-version channel.');
    }
  } else if (layerName === 'firefoxCurrentPackaged') {
    if (
      layer?.browser?.name !== 'firefox'
      || layer.browser.channel !== 'current-stable'
      || !Number.isInteger(browserMajor(layer.browser.version))
    ) {
      errors.push('firefoxCurrentPackaged must run a versioned Firefox current-stable browser.');
    }
    if (typeof options?.currentFirefoxStableVersion !== 'string') {
      errors.push(
        'Externally resolved Firefox current-stable version is required.',
      );
    } else if (
      layer?.browser?.version !== options.currentFirefoxStableVersion
    ) {
      errors.push(
        `firefoxCurrentPackaged version must equal externally resolved current stable ${options.currentFirefoxStableVersion}.`,
      );
    }
  } else if (layerName === 'chrome109Regression') {
    if (
      layer?.browser?.name !== 'chrome'
      || layer.browser.channel !== 'minimum'
      || browserMajor(layer.browser.version) !== 109
    ) {
      errors.push('chrome109Regression must run Chrome 109 on the minimum-version channel.');
    }
  }

  if (layerName.startsWith('firefox')) {
    if (layer?.entryMode !== 'packaged-user-entry') {
      errors.push(
        `${layerName} must exercise packaged user entries, not a direct runtime probe.`,
      );
    }
    if (layer?.artifact?.kind !== 'xpi') {
      errors.push(`${layerName} must use an XPI artifact.`);
    }
    if (!['packaged', 'signed'].includes(layer?.artifact?.installation)) {
      errors.push(
        `${layerName} permission evidence must use a packaged or signed XPI, not a temporary installation.`,
      );
    }
  } else if (layer?.artifact?.kind !== 'chrome-zip') {
    errors.push('chrome109Regression must use the canonical Chrome ZIP artifact.');
  }
  if (!sha256Pattern.test(layer?.artifact?.sha256 ?? '')) {
    errors.push(`${layerName} artifact must have a lowercase SHA-256.`);
  }
  assertNonEmptyStringOrError(
    layer?.artifact?.path,
    `${layerName} artifact path`,
    errors,
  );
  if (typeof layer?.artifact?.path === 'string') {
    try {
      const artifactPath = resolve(
        options.evidenceBaseDirectory,
        layer.artifact.path,
      );
      if (readSha256(artifactPath) !== layer.artifact.sha256) {
        errors.push(`${layerName} artifact SHA-256 does not match its bytes.`);
      }
    } catch {
      errors.push(`${layerName} artifact could not be read.`);
    }
  }
}

function readVerifiedReceipts(evidence, options, errors) {
  const receipts = {};
  for (const layerName of evidenceLayers) {
    const reference = evidence?.receipts?.[layerName];
    if (
      typeof reference?.path !== 'string'
      || reference.path.length === 0
      || !sha256Pattern.test(reference?.sha256 ?? '')
    ) {
      errors.push(`${layerName} receipt reference is invalid.`);
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(resolve(options.evidenceBaseDirectory, reference.path));
    } catch {
      errors.push(`${layerName} receipt could not be read.`);
      continue;
    }
    if (sha256(bytes) !== reference.sha256) {
      errors.push(`${layerName} receipt SHA-256 does not match its bytes.`);
      continue;
    }
    let receipt;
    try {
      receipt = JSON.parse(bytes.toString('utf8'));
    } catch {
      errors.push(`${layerName} receipt is not valid JSON.`);
      continue;
    }
    if (receipt?.schemaVersion !== 1 || receipt?.layer !== layerName) {
      errors.push(`${layerName} receipt identity is invalid.`);
      continue;
    }
    if (receipt.runner !== expectedReceiptRunners[layerName]) {
      errors.push(`${layerName} receipt was not produced by the required runner.`);
    }
    const observations = new Map();
    if (!Array.isArray(receipt.observations)) {
      errors.push(`${layerName} receipt runner observations are missing.`);
    } else {
      for (const observation of receipt.observations) {
        if (
          typeof observation?.id !== 'string'
          || observations.has(observation.id)
        ) {
          errors.push(`${layerName} receipt has an invalid runner observation.`);
          continue;
        }
        observations.set(observation.id, observation.status);
      }
    }
    for (const capabilityEvidence of Object.values(receipt.coverage ?? {})) {
      for (const evidenceId of Array.isArray(capabilityEvidence)
        ? capabilityEvidence
        : []) {
        if (observations.get(evidenceId) !== 'pass') {
          errors.push(
            `${layerName} coverage ${evidenceId} has no passing runner observation.`,
          );
        }
      }
    }
    for (const field of [
      'commit',
      'extensionVersion',
      'lockfileSha256',
      'modelManifestSha256',
    ]) {
      if (receipt?.identity?.[field] !== evidence?.identity?.[field]) {
        errors.push(`${layerName} receipt does not match evidence identity ${field}.`);
      }
    }
    receipts[layerName] = receipt;
  }
  return receipts;
}

function validateProhibitedBehaviors(matrix, evidence, errors) {
  const checks = evidence?.prohibitedBehaviorChecks;
  if (!Array.isArray(checks)) {
    errors.push('Prohibited behavior checks are missing.');
    return;
  }
  const byId = new Map();
  for (const check of checks) {
    if (byId.has(check?.id)) {
      errors.push(`Duplicate prohibited behavior check ${String(check?.id)}.`);
      continue;
    }
    byId.set(check?.id, check);
  }
  for (const id of matrix.prohibitedBehaviors) {
    const check = byId.get(id);
    if (
      check?.status !== 'pass'
      || typeof check.evidence !== 'string'
      || check.evidence.length === 0
    ) {
      errors.push(`Prohibited behavior check ${id} did not pass.`);
    }
  }
  for (const id of byId.keys()) {
    if (!matrix.prohibitedBehaviors.includes(id)) {
      errors.push(`Unknown prohibited behavior check ${String(id)}.`);
    }
  }
}

export function evaluateFirefoxCapabilityEvidence(
  matrixInput,
  evidence,
  optionsInput = {},
) {
  const matrix = assertFirefoxCapabilityMatrix(matrixInput);
  const errors = [];
  const repositoryRoot = resolve(
    optionsInput.repositoryRoot
      ?? import.meta.dirname,
    optionsInput.repositoryRoot ? '.' : '../../..',
  );
  const options = {
    ...optionsInput,
    repositoryRoot,
    evidenceBaseDirectory: resolve(
      optionsInput.evidenceBaseDirectory ?? process.cwd(),
    ),
  };
  if (evidence?.schemaVersion !== 1) {
    errors.push('Firefox capability evidence schemaVersion must be 1.');
  }
  let trustedIdentity;
  try {
    trustedIdentity = resolveRepositoryEvidenceIdentity(repositoryRoot);
  } catch (error) {
    errors.push(
      error instanceof Error
        ? error.message
        : 'Checked-out repository identity could not be resolved.',
    );
  }
  validateIdentity(evidence?.identity, trustedIdentity, errors);
  const layers = readVerifiedReceipts(evidence, options, errors);
  validateProhibitedBehaviors(
    matrix,
    layers.adapterContract,
    errors,
  );

  for (const layerName of evidenceLayers) {
    const layer = layers[layerName];
    if (layerName === 'inventory' || layerName === 'adapterContract') {
      if (layer?.status !== 'pass') errors.push(`${layerName} did not pass.`);
    } else {
      validateBrowserLayer(layerName, layer, options, errors);
    }
    for (const capabilityId of Object.keys(layer?.coverage ?? {})) {
      if (!matrix.capabilities.some(({ id }) => id === capabilityId)) {
        errors.push(`${layerName} contains unknown capability ${capabilityId}.`);
      }
    }
  }
  const firefox140Sha = layers.firefox140Packaged?.artifact?.sha256;
  const firefoxCurrentSha = layers.firefoxCurrentPackaged?.artifact?.sha256;
  if (firefox140Sha && firefoxCurrentSha && firefox140Sha !== firefoxCurrentSha) {
    errors.push('Firefox 140 and current-stable evidence must use the same XPI bytes.');
  }

  const capabilities = matrix.capabilities.map((capability) => {
    const capabilityErrors = [];
    for (const layerName of evidenceLayers) {
      const required = capability.evidence[layerName];
      for (const id of missingEvidence(
        required,
        layers[layerName]?.coverage?.[capability.id],
      )) {
        capabilityErrors.push(`${layerName} is missing evidence ${id}.`);
      }
    }
    return {
      id: capability.id,
      title: capability.title,
      userEntry: capability.userEntry,
      sharedContract: capability.sharedContract,
      status: capabilityErrors.length === 0 ? 'pass' : 'fail',
      errors: capabilityErrors,
    };
  });
  const passedCapabilities = capabilities.filter(
    ({ status }) => status === 'pass',
  ).length;
  const complete = errors.length === 0
    && passedCapabilities === matrix.capabilities.length;
  return {
    schemaVersion: 1,
    conclusion: complete ? 'complete-parity' : 'incomplete',
    passedCapabilities,
    totalCapabilities: matrix.capabilities.length,
    identity: evidence?.identity ?? null,
    errors,
    capabilities,
  };
}

function escapeTableCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderFirefoxCapabilitySummary(report) {
  const passed = report.conclusion === 'complete-parity';
  const lines = [
    `# Firefox complete capability parity: ${passed ? 'PASS' : 'INCOMPLETE'} (${report.passedCapabilities}/${report.totalCapabilities})`,
    '',
  ];
  if (report.errors.length > 0) {
    lines.push('## Evidence errors', '');
    for (const error of report.errors) lines.push(`- ${error}`);
    lines.push('');
  }
  lines.push(
    '| Capability | User entry | Shared contract | Status |',
    '| --- | --- | --- | --- |',
  );
  for (const capability of report.capabilities) {
    lines.push(
      `| ${escapeTableCell(capability.id)} — ${escapeTableCell(capability.title)} | ${escapeTableCell(capability.userEntry)} | ${escapeTableCell(capability.sharedContract)} | ${capability.status.toUpperCase()} |`,
    );
  }
  const failed = report.capabilities.filter(({ status }) => status === 'fail');
  if (failed.length > 0) {
    lines.push('', '## Missing capability evidence', '');
    for (const capability of failed) {
      for (const error of capability.errors) {
        lines.push(`- ${capability.id}: ${error}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const matrix = loadFirefoxCapabilityMatrix();
  const evidenceOptionIndex = process.argv.indexOf('--evidence');
  if (evidenceOptionIndex === -1) {
    console.log(JSON.stringify(matrix, null, 2));
  } else {
    const evidencePath = process.argv[evidenceOptionIndex + 1];
    if (!evidencePath) throw new Error('--evidence requires a JSON path.');
    const resolvedEvidencePath = resolve(evidencePath);
    const evidence = JSON.parse(readFileSync(resolvedEvidencePath, 'utf8'));
    const report = evaluateFirefoxCapabilityEvidence(matrix, evidence, {
      evidenceBaseDirectory: dirname(resolvedEvidencePath),
      currentFirefoxStableVersion:
        process.env.FIREFOX_CURRENT_STABLE_VERSION,
    });
    console.log(
      process.argv.includes('--json')
        ? JSON.stringify(report, null, 2)
        : renderFirefoxCapabilitySummary(report),
    );
    if (report.conclusion !== 'complete-parity') process.exitCode = 1;
  }
}
