// ---------------------------------------------------------------------------
// Color diagnostic/comparison types
// ---------------------------------------------------------------------------

/** Human-annotated expected colors for one text region in a fixture image. */
export type ColorFixtureRegion = {
  bbox: [number, number, number, number]; // [x, y, w, h]
  expectedFg: [number, number, number];
  expectedBg: [number, number, number];
};

/** One fixture image + its annotated regions. */
export type ColorFixture = {
  imageFile: string;
  regions: ColorFixtureRegion[];
};

/** Which color extraction path was taken. */
export type ColorPath =
  | "ocr_model"
  | "pixel_sampling"
  | "default";

/** Trace info for a single region's color extraction. */
export type RegionDiagnosticTrace = {
  fixtureImage: string;
  regionIndex: number;
  bbox: [number, number, number, number];

  /** Color path taken. */
  colorPath: ColorPath;

  /** OCR model path: hasFg step ratio (cntFg / maxSteps). */
  hasFgRatio: number | null;
  /** OCR model path: hasBg step ratio (cntBg / maxSteps). */
  hasBgRatio: number | null;

  /** Raw fg RGB before resolveColors (from OCR or pixel sampling). */
  rawFgRgb: [number, number, number] | null;
  /** Raw bg RGB before resolveColors. */
  rawBgRgb: [number, number, number] | null;

  /** Resolved fg RGB after resolveColors. */
  resolvedFgRgb: [number, number, number];
  /** Resolved bg RGB after resolveColors. */
  resolvedBgRgb: [number, number, number];

  /** Whether the safety net triggered (DeltaE < 30 between raw fg/bg). */
  safetyNetTriggered: boolean;

  /** DeltaE between raw fg and raw bg (before safety net). */
  rawDeltaE: number | null;

  /** Human-annotated expected fg RGB. */
  expectedFgRgb: [number, number, number];
  /** Human-annotated expected bg RGB. */
  expectedBgRgb: [number, number, number];

  /** DeltaE between resolved fg and expected fg. */
  fgDeltaE: number;
  /** DeltaE between resolved bg and expected bg. */
  bgDeltaE: number;

  /** Whether this region is a "gray failure" (fg/bg DeltaE < 30). */
  isGrayFailure: boolean;
};

/** Summary statistics grouped by color path. */
export type PathSummary = {
  path: ColorPath;
  regionCount: number;
  grayFailureRate: number;
  avgDeltaE: number;
  avgFgDeltaE: number;
  avgBgDeltaE: number;
  hitRateDeltaE20: number;
};

/** Full diagnostic report. */
export type DiagnosticReport = {
  generatedAt: string;
  fixtureCount: number;
  totalRegionCount: number;
  traces: RegionDiagnosticTrace[];
  pathSummaries: PathSummary[];
};

/** Metrics for one algorithm on one region. */
export type AlgorithmRegionResult = {
  fixtureImage: string;
  regionIndex: number;
  bbox: [number, number, number, number];
  algorithm: string;

  fgRgb: [number, number, number];
  bgRgb: [number, number, number];

  expectedFgRgb: [number, number, number];
  expectedBgRgb: [number, number, number];

  fgDeltaE: number;
  bgDeltaE: number;
  isGrayFailure: boolean;
};

/** Per-algorithm summary metrics. */
export type AlgorithmSummary = {
  algorithm: string;
  regionCount: number;
  grayFailureRate: number;
  avgDeltaE: number;
  avgFgDeltaE: number;
  avgBgDeltaE: number;
  hitRateDeltaE20: number;
  colorPathDistribution: Record<ColorPath, number>;
};

/** Full comparison report. */
export type ComparisonReport = {
  generatedAt: string;
  fixtureCount: number;
  totalRegionCount: number;
  regionResults: AlgorithmRegionResult[];
  algorithmSummaries: AlgorithmSummary[];
};