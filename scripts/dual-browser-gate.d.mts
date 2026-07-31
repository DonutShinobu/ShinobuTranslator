export type DualBrowserGateLevel =
  | 'base'
  | 'extension_artifacts'
  | 'execution_conformance';

export interface DualBrowserGateConfig {
  version: 1;
  unknownLevel: DualBrowserGateLevel;
  rules: Array<{
    level: DualBrowserGateLevel;
    patterns: string[];
  }>;
}

export interface DualBrowserGateClassification {
  base: true;
  extensionArtifacts: boolean;
  executionConformance: boolean;
}

export function loadDualBrowserGateConfig(
  configPath?: string,
): DualBrowserGateConfig;

export function collectChangedPaths(input: {
  base: string;
  head: string;
  repositoryRoot?: string;
}): string[];

export function classifyDualBrowserGatePaths(
  paths: string[],
  config: DualBrowserGateConfig,
): DualBrowserGateClassification;

export function assertDualBrowserGate(input: {
  expectedExtensionArtifacts: boolean;
  results: {
    classify?: string;
    base?: string;
    extensionArtifacts?: string;
  };
}): void;
