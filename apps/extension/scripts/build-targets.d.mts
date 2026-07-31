export type ExtensionBuildTarget =
  | 'chrome'
  | 'firefox'
  | 'benchmark'
  | 'conformance-chrome'
  | 'conformance-firefox'
  | 'conformance-detector-chrome'
  | 'conformance-detector-firefox'
  | 'conformance-translation-chrome'
  | 'conformance-translation-firefox'
  | 'conformance-lifecycle-chrome'
  | 'conformance-lifecycle-firefox';

export type ExtensionBuildTargetDescriptor = {
  browser: 'chrome' | 'firefox';
  manifestTarget: 'chrome' | 'firefox';
  outDir: string;
  release: boolean;
  conformance?: boolean;
  conformanceProfile?:
    | 'detector-failure'
    | 'translation-failure'
    | 'lifecycle';
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
