export function mean(values: readonly number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

export function meanOr(values: readonly number[], fallback: number): number {
  return values.length > 0 ? mean(values) : fallback;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
