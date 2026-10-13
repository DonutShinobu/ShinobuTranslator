import type { SourceMapPayload } from 'node:module';
import type { Plugin } from 'vite';

interface LintWarning {
  file: string;
  line?: number | null;
  column?: number | null;
}

interface LintWarningSource {
  source: string;
  sha256: string;
  line: number;
  column: number;
}

export function firefoxLintSourceMapsPlugin(outputDir: string): Plugin;
export function decodeLintWarningSource(
  dist: string,
  warning: LintWarning,
  bundleBytes: Uint8Array | string,
  audit: { bundleSha256: string; sourceMap: SourceMapPayload },
): LintWarningSource;
export function readLintWarningSource(dist: string, warning: LintWarning): LintWarningSource;
