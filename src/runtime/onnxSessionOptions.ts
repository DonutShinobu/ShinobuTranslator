export type OnnxValueDataLocation = "cpu" | "cpu-pinned" | "gpu-buffer" | "ml-tensor";

export type OnnxSessionOptions = {
  enableGraphCapture?: boolean;
  preferredOutputLocation?: OnnxValueDataLocation | Record<string, OnnxValueDataLocation>;
  freeDimensionOverrides?: Record<string, number>;
};

function stableRecord<T>(record: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function serializeOnnxSessionOptions(options?: OnnxSessionOptions): string {
  if (!options) return "default";
  const normalized: OnnxSessionOptions = {};
  if (typeof options.enableGraphCapture === "boolean") {
    normalized.enableGraphCapture = options.enableGraphCapture;
  }
  if (typeof options.preferredOutputLocation === "string") {
    normalized.preferredOutputLocation = options.preferredOutputLocation;
  } else if (options.preferredOutputLocation) {
    normalized.preferredOutputLocation = stableRecord(options.preferredOutputLocation);
  }
  const freeDimensionOverrides = stableRecord(options.freeDimensionOverrides);
  if (freeDimensionOverrides) {
    normalized.freeDimensionOverrides = freeDimensionOverrides;
  }
  return JSON.stringify(normalized);
}
