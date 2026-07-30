export type ArchitectureSourceFile = Readonly<{
  relativePath: string;
  source: string;
}>;

export const frozenExtensionMigrationEdgeKeys: readonly string[];

export const frozenExtensionMigrationRemovalCondition: Readonly<{
  trigger: string;
  action: string;
  indefiniteRetentionAllowed: false;
}>;

export function findFrozenMigrationEdgeViolations(
  files: readonly ArchitectureSourceFile[],
): string[];

export function findSourcePolicyViolations(
  files: readonly ArchitectureSourceFile[],
): string[];

export function scanExtensionArchitecture(
  repositoryRoot: string,
): Promise<string[]>;
