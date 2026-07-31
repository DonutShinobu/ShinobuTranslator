import { extname, resolve } from 'node:path';

export async function resolveFirefoxSmokePackage({
  xpiPath,
  isAccessible,
}) {
  if (typeof xpiPath !== 'string' || xpiPath.length === 0) {
    throw new Error(
      'FIREFOX_XPI must point to the packaged or signed XPI under test; '
        + 'a temporary directory install is not valid permission evidence.',
    );
  }
  const path = resolve(xpiPath);
  if (extname(path).toLowerCase() !== '.xpi') {
    throw new Error(`Firefox permission smoke requires an .xpi artifact: ${path}`);
  }
  if (!await isAccessible(path)) {
    throw new Error(`FIREFOX_XPI is not readable: ${path}`);
  }
  return { path, temporary: false };
}

export function resolveFirefoxSmokeEntryMode(browserVersion) {
  const major = Number.parseInt(String(browserVersion).split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < 140) {
    throw new Error(
      `Firefox packaged capability smoke requires Firefox 140+: ${browserVersion}`,
    );
  }
  return 'packaged-user-entry';
}
