export type ExtensionBuildTarget =
  | 'chrome'
  | 'firefox'
  | 'benchmark'
  | 'conformance-chrome'
  | 'conformance-firefox';

export type ExtensionBuildTargetDescriptor = {
  browser: 'chrome' | 'firefox';
  manifestTarget: 'chrome' | 'firefox';
  outDir: string;
  release: boolean;
  conformance?: boolean;
};

export const extensionBuildTargets: Readonly<
  Record<ExtensionBuildTarget, Readonly<ExtensionBuildTargetDescriptor>>
>;

export function resolveExtensionBuildTarget(
  target: string,
): ExtensionBuildTargetDescriptor & {
  target: ExtensionBuildTarget;
  absoluteOutDir: string;
};
