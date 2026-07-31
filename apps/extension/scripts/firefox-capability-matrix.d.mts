export type FirefoxCapabilityEvidence = {
  inventory: string[];
  adapterContract: string[];
  firefox140Packaged: string[];
  firefoxCurrentPackaged: string[];
  chrome109Regression: string[];
};

export type FirefoxCapability = {
  id: string;
  title: string;
  userEntry: string;
  sharedContract: string;
  scenarios: {
    success: string[];
    criticalFailure: string[];
  };
  evidence: FirefoxCapabilityEvidence;
};

export type FirefoxCapabilityMatrix = {
  schemaVersion: 1;
  title: string;
  prohibitedBehaviors: string[];
  traceability: Record<string, {
    entry: string[];
    contract: string[];
    tests: string[];
  }>;
  capabilities: FirefoxCapability[];
};

export type FirefoxEvidenceIdentity = {
  commit: string;
  extensionVersion: string;
  lockfileSha256: string;
  modelManifestSha256: string;
};

export type ProhibitedBehaviorCheck = {
  id: string;
  status: 'pass' | 'fail';
  evidence: string;
};

type EvidenceArtifact = {
  kind: string;
  path: string;
  sha256: string;
  installation?: 'packaged' | 'signed' | 'temporary';
};

export type FirefoxCapabilityEvidenceReceipt = {
  schemaVersion: 1;
  layer:
    | 'inventory'
    | 'adapterContract'
    | 'firefox140Packaged'
    | 'firefoxCurrentPackaged'
    | 'chrome109Regression';
  runner: string;
  identity: FirefoxEvidenceIdentity;
  status: 'pass' | 'fail';
  coverage: Record<string, string[]>;
  observations: Array<{ id: string; status: 'pass' | 'fail' }>;
  prohibitedBehaviorChecks?: ProhibitedBehaviorCheck[];
  entryMode?: 'packaged-user-entry' | 'direct-port';
  browser?: { name: string; version: string; channel: string };
  artifact?: EvidenceArtifact;
};

export type EvidenceReceiptReference = {
  path: string;
  sha256: string;
};

export type FirefoxCapabilityEvidenceBundle = {
  schemaVersion: 1;
  identity: FirefoxEvidenceIdentity;
  receipts: {
    inventory: EvidenceReceiptReference;
    adapterContract: EvidenceReceiptReference;
    firefox140Packaged: EvidenceReceiptReference;
    firefoxCurrentPackaged: EvidenceReceiptReference;
    chrome109Regression: EvidenceReceiptReference;
  };
};

export type FirefoxCapabilityEvaluationOptions = {
  evidenceBaseDirectory?: string;
  repositoryRoot?: string;
  currentFirefoxStableVersion?: string;
};

export type FirefoxCapabilityEvidenceReport = {
  schemaVersion: 1;
  conclusion: 'complete-parity' | 'incomplete';
  passedCapabilities: number;
  totalCapabilities: number;
  identity: FirefoxCapabilityEvidenceBundle['identity'] | null;
  errors: string[];
  capabilities: Array<{
    id: string;
    title: string;
    userEntry: string;
    sharedContract: string;
    status: 'pass' | 'fail';
    errors: string[];
  }>;
};

export function assertFirefoxCapabilityMatrix(
  matrix: unknown,
): FirefoxCapabilityMatrix;
export function loadFirefoxCapabilityMatrix(): FirefoxCapabilityMatrix;
export function resolveRepositoryEvidenceIdentity(
  repositoryRoot: string,
): FirefoxEvidenceIdentity;
export function evaluateFirefoxCapabilityEvidence(
  matrix: FirefoxCapabilityMatrix,
  evidence: FirefoxCapabilityEvidenceBundle,
  options?: FirefoxCapabilityEvaluationOptions,
): FirefoxCapabilityEvidenceReport;
export function renderFirefoxCapabilitySummary(
  report: FirefoxCapabilityEvidenceReport,
): string;
