import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Web production security headers', () => {
  it('keeps the browser app self-hosted and cross-origin isolated', async () => {
    const source = await readFile('apps/web/_headers', 'utf8');
    const csp = source.split(/\r?\n/u).find((line) =>
      line.trimStart().startsWith('Content-Security-Policy:'));

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("connect-src 'self' https:");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain('trusted-types default');
    expect(source).toContain('Cross-Origin-Opener-Policy: same-origin');
    expect(source).toContain('Cross-Origin-Embedder-Policy: require-corp');
    expect(source).toContain('Referrer-Policy: no-referrer');
    expect(source).toContain('Permissions-Policy: camera=(self)');
    expect(source).toContain('microphone=()');
  });
});
