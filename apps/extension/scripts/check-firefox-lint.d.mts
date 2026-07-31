export const firefoxLintVendorExclusions: readonly string[];

export function assertFirefoxLintResult(input: {
  status: number | null;
  report: {
    summary?: {
      errors?: number;
      warnings?: number;
    };
    errors?: Array<{ code?: string }>;
    warnings?: Array<{ code?: string }>;
  };
  stderr: string;
}): void;
