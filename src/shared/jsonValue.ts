import type {
  JsonValue,
} from '../../apps/extension/src/capabilities/contracts';

function normalizeJsonValueInternal(
  value: unknown,
  seen: Set<object>,
): JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError('JsonValue 数字必须是有限值');
  }
  if (typeof value !== 'object') {
    throw new TypeError(`无法序列化为 JsonValue: ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new TypeError('JsonValue 不允许循环引用');
  }

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new TypeError('JsonValue 数组必须使用标准原型');
    }
    seen.add(value);
    try {
      const normalized: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('JsonValue 数组不允许稀疏项');
        }
        const entry = value[index];
        if (entry === undefined) {
          throw new TypeError('JsonValue 数组不允许 undefined');
        }
        normalized.push(normalizeJsonValueInternal(entry, seen));
      }
      return normalized;
    } finally {
      seen.delete(value);
    }
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('JsonValue 对象必须是普通对象');
  }

  seen.add(value);
  try {
    const normalized: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      normalized[key] = normalizeJsonValueInternal(entry, seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

export function normalizeJsonValue(value: unknown): JsonValue {
  return normalizeJsonValueInternal(value, new Set());
}
