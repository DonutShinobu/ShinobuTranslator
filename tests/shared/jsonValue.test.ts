import { describe, expect, it } from 'vitest';
import { isJsonValue } from '../../apps/extension/src/capabilities/chromeInternal';
import { normalizeJsonValue } from '../../src/shared/jsonValue';

describe('normalizeJsonValue', () => {
  it('normalizes nested business objects and omits undefined object properties', () => {
    const normalized = normalizeJsonValue({
      type: 'request',
      optional: undefined,
      nested: [{ value: 1 }],
    });

    expect(normalized).toEqual({
      type: 'request',
      nested: [{ value: 1 }],
    });
    expect(isJsonValue(normalized)).toBe(true);
  });

  it('preserves __proto__ as an ordinary JSON key', () => {
    const normalized = normalizeJsonValue(
      JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
    );

    expect(Object.hasOwn(normalized as object, '__proto__')).toBe(true);
    expect((normalized as Record<string, unknown>).__proto__).toEqual({
      polluted: true,
    });
    expect(isJsonValue(normalized)).toBe(true);
  });

  it('rejects sparse arrays, cycles, and non-finite numbers', () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = 'present';
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => normalizeJsonValue(sparse)).toThrow('稀疏项');
    expect(() => normalizeJsonValue(cyclic)).toThrow('循环引用');
    expect(() => normalizeJsonValue(Number.NaN)).toThrow('有限值');
  });
});
