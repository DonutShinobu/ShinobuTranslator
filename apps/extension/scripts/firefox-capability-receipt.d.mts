import type {
  EvidenceReceiptReference,
  FirefoxCapabilityEvidenceReceipt,
  ProhibitedBehaviorCheck,
} from './firefox-capability-matrix.mjs';

type WrittenReceipt = {
  receipt: FirefoxCapabilityEvidenceReceipt;
  reference: EvidenceReceiptReference;
};

export function writeFirefoxPackagedReceipt(options: {
  layer: 'firefox140Packaged' | 'firefoxCurrentPackaged';
  browserVersion: string;
  artifactPath: string;
  installation: 'packaged' | 'signed';
  outputPath: string;
  repositoryRoot: string;
  observedEvidence: string[];
}): Promise<WrittenReceipt>;

export function writeContractReceipt(options: {
  layer: 'inventory' | 'adapterContract';
  testReportPath: string;
  outputPath: string;
  repositoryRoot: string;
  prohibitedBehaviorChecks?: ProhibitedBehaviorCheck[];
  observedEvidence: string[];
}): Promise<WrittenReceipt>;
