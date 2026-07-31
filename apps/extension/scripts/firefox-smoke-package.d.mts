export function resolveFirefoxSmokePackage(options: {
  xpiPath: string | undefined;
  isAccessible(path: string): Promise<boolean>;
}): Promise<{ path: string; temporary: false }>;
export function resolveFirefoxSmokeEntryMode(
  browserVersion: string,
): 'packaged-user-entry';
