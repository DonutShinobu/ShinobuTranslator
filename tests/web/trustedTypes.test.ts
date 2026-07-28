import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertTrustedScriptUrl,
  installTrustedTypesPolicy,
} from '../../apps/web/src/runtime/trustedTypes';

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & {
    __shinobuTrustedTypesDefaultPolicy?: unknown;
  }).__shinobuTrustedTypesDefaultPolicy;
});

describe('Trusted Types default Script URL policy', () => {
  it('allows only same-origin HTTP(S) and blob URLs', () => {
    vi.stubGlobal('location', new URL('https://shinobu.example/app'));

    expect(assertTrustedScriptUrl('/worker.js')).toBe('/worker.js');
    expect(assertTrustedScriptUrl('blob:https://shinobu.example/id')).toContain('blob:');
    expect(() => assertTrustedScriptUrl('blob:https://attacker.example/id')).toThrow(/同源/u);
    expect(() => assertTrustedScriptUrl('data:text/javascript,alert(1)')).toThrow(/同源/u);
    expect(() => assertTrustedScriptUrl('https://attacker.example/worker.js')).toThrow(/同源/u);
  });

  it('installs and reuses the browser default policy', () => {
    vi.stubGlobal('location', new URL('https://shinobu.example/app'));
    const createPolicy = vi.fn((
      _name: string,
      rules: { createScriptURL(value: string): string },
    ) => ({
      createScriptURL: (value: string) => `trusted:${rules.createScriptURL(value)}`,
    }));
    vi.stubGlobal('trustedTypes', { createPolicy });

    installTrustedTypesPolicy();
    installTrustedTypesPolicy();
    expect(createPolicy).toHaveBeenCalledOnce();
    expect(createPolicy).toHaveBeenCalledWith('default', expect.any(Object));
  });
});
