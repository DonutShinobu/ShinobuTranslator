import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default function buildExtensionForCookieTests(): void {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const extensionRoot = resolve(repoRoot, 'apps/extension');
  const options = { cwd: extensionRoot, stdio: 'inherit' as const, windowsHide: true };
  // Rebuild the actual startup path. The ONNX worker and model files are not
  // needed for provider authorization and are intentionally outside this test.
  execFileSync(process.execPath, [
    resolve(repoRoot, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'chromium',
  ], options);
  execFileSync(process.execPath, [
    'scripts/build-content.mjs', '--out-dir', 'dist-chromium',
  ], options);
  writeFileSync(resolve(extensionRoot, 'dist-chromium/cookie-test.html'), '<!doctype html><title>Cookie test</title>');
}
