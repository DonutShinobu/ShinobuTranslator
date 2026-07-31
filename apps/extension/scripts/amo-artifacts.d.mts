import type {
  AmoCanonicalZipEntry,
} from './amo-canonical-zip.mjs';
import type {
  AmoBuildAssetProof,
  AmoReviewerRuntime,
} from './amo-build-contract.mjs';

export interface AmoArtifactFileNames {
  xpi: string;
  source: string;
  xpiManifest: string;
  sourceManifest: string;
  receipt: string;
}

export interface AmoReceiptInputs extends AmoBuildAssetProof {
  runtime: AmoReviewerRuntime;
  lockfileSha256: string;
}

export function collectAmoSourceEntries(
  sourceRoot: string,
): AmoCanonicalZipEntry[];

export function collectAmoArchiveEntries(
  directory: string,
): AmoCanonicalZipEntry[];

export function enforceAmoArchiveSize(input: {
  label: string;
  bytes: number;
  warn?: (message: string) => void;
}): void;

export function writeAmoArtifacts(input: {
  outputDirectory: string;
  extensionVersion: string;
  xpiEntries: AmoCanonicalZipEntry[];
  sourceEntries: AmoCanonicalZipEntry[];
  receiptInputs: AmoReceiptInputs;
  warn?: (message: string) => void;
}): {
  fileNames: AmoArtifactFileNames;
  receipt: Record<string, any>;
};
