export interface AmoReviewerRuntime {
  platform: string;
  architecture: string;
  operatingSystem: string;
  node: string;
  npm: string;
}

export interface AmoBuildContract {
  schemaVersion: number;
  reviewerRuntime: Readonly<AmoReviewerRuntime>;
  install: Readonly<{
    command: string;
    lockfileVersion: number;
    webExt: string;
  }>;
  modelPackageVersion: string;
  archive: Readonly<{
    warningBytes: number;
    hardLimitBytes: number;
  }>;
}

export interface AmoBuildAssetProof {
  modelManifestVersion: string;
  modelManifestSha256: string;
  staticAssetManifestSha256: string;
}

export const AMO_BUILD_CONTRACT: Readonly<AmoBuildContract>;

export function assertAmoReviewerEnvironment<T extends AmoReviewerRuntime>(
  runtime: T,
): T;

export function assertAmoBuildEnvironment(
  environment: Record<string, string | undefined>,
): void;

export function assertAmoPackageMetadata(input: {
  packageMetadata: Record<string, any>;
  lockfile: Record<string, any>;
}): void;

export function verifyAmoBuildAssets(input: {
  root: string;
}): AmoBuildAssetProof;
