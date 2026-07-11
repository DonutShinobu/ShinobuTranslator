export type GroundTruthCharCenter = {
  x?: number;
  y: number;
};

export type TypesetDirection = "h" | "v";

export type GroundTruthColumn = {
  index: number;
  text: string;
  charCount: number;
  centerX: number;
  topY: number;
  bottomY: number;
  width: number;
  height: number;
  estimatedFontSize: number;
  charCenters: GroundTruthCharCenter[];
  quad?: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
};

export type GroundTruth = {
  columns: GroundTruthColumn[];
};

export type TypesetSnapshot = {
  fittedFontSize: number;
  columns: GroundTruthColumn[];
};

export type FixtureImage = {
  file: string;
  width: number;
  height: number;
  sha256: string;
};

export type BakeInfo = {
  gitCommit: string;
  detectorModel: string;
  ocrModel: string;
  direction?: "all" | "h" | "v";
};

export type FixtureRegion = {
  id: string;
  direction: TypesetDirection;
  box: { x: number; y: number; width: number; height: number };
  quad?: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  sourceText: string;
  fontSize?: number;
  fgColor?: [number, number, number];
  bgColor?: [number, number, number];
  originalLineCount?: number;
  translatedColumns?: string[];
  groundTruth: GroundTruth;
  currentTypeset: TypesetSnapshot;
};

export type Fixture = {
  schemaVersion: number;
  image: FixtureImage;
  bakedAt: string;
  bakedWith: BakeInfo;
  regions: FixtureRegion[];
};

export type RegionMetricBase = {
  regionId: string;
  direction: TypesetDirection;
  skipped: boolean;
  skipReason?: string;
  sourceGeometryStatus?: string;
};

export type VerticalMetricValues = {
  columnCountMatch: number;
  columnCountDiff: number;
  columnIouMean: number;
  columnIouMin: number;
  fontSizeRatio: number;
  fontSizeError: number;
  signedColumnDxNormMean: number;
  columnDxNormMean: number;
  columnDxNormMax: number;
  signedColumnGapNormMean: number;
  columnPitchRatioMean: number;
  dTopNormMean: number;
  dBottomNormMean: number;
  heightRatioMean: number;
  signedCharDyNormMean: number;
  charDyNormMean: number;
  charDyNormMax: number;
  charDyNormP95: number;
  signedCharAdvanceNormMean: number;
  charAdvanceRatioMean: number;
  compositeScore: number;
  glyphQualityCoverage?: number;
  glyphOrientationAccuracy?: number;
  runContinuityRate?: number;
  verticalItemCenterAlignment?: number;
  glyphQualityScore?: number;
};

export type VerticalRegionMetrics = RegionMetricBase & VerticalMetricValues & {
  direction: "v";
  skipped: false;
};

export type HorizontalMetricValues = {
  lineCountMatch: number;
  lineCountDiff: number;
  lineQuadIouMean: number;
  lineQuadIouMin: number;
  blockHullIou: number;
  sourceQuadCoverage: number;
  fontSizeRatio: number;
  fontSizeError: number;
  signedLineCenterDxNormMean: number;
  signedLineCenterDyNormMean: number;
  lineCenterDistanceNormMean: number;
  lineCenterDistanceNormP95: number;
  lineCenterDistanceNormMax: number;
  lineWidthRatioMean: number;
  lineWidthErrorMean: number;
  lineHeightRatioMean: number;
  lineHeightErrorMean: number;
  signedLineGapNormMean: number;
  linePitchRatioMean: number;
  linePitchErrorMean: number;
  lineAngleErrorDegMean: number;
  lineAngleErrorDegMax: number;
  lineBreakPrecision: number;
  lineBreakRecall: number;
  lineBreakF1: number;
  gtGlyphCount: number;
  predGlyphCount: number;
  matchedGlyphCount: number;
  positionedGlyphCount: number;
  glyphTextMatchCoverage: number;
  glyphPositionCoverage: number;
  signedCharDxNormMean: number;
  signedCharDyNormMean: number;
  charDxNormMean: number;
  charDyNormMean: number;
  charDistanceNormMean: number;
  charDistanceNormMedian: number;
  charDistanceNormP95: number;
  charDistanceNormMax: number;
  charDistanceOverHalfEmRate: number;
  charDistanceOverOneEmRate: number;
  signedCharAdvanceNormMean: number;
  charAdvanceRatioMean: number;
  charAdvanceErrorMean: number;
  charCenterQuality: number;
  compositeScore: number;
};

export type HorizontalRegionMetrics = RegionMetricBase & HorizontalMetricValues & {
  direction: "h";
  skipped: false;
};

export type SkippedRegionMetrics = RegionMetricBase & {
  skipped: true;
};

export type RegionMetrics =
  | VerticalRegionMetrics
  | HorizontalRegionMetrics
  | SkippedRegionMetrics;

export type ImageMetrics = {
  imageFile: string;
  regionCount: number;
  skippedCount: number;
  regions: RegionMetrics[];
  verticalScoredCount: number;
  horizontalScoredCount: number;
  avgCompositeScore: number;
  avgHorizontalCompositeScore: number;
  avgGlyphQualityCoverage: number;
  avgGlyphOrientationAccuracy: number;
  avgRunContinuityRate: number;
  avgVerticalItemCenterAlignment: number;
  avgGlyphQualityScore: number;
};

export type HorizontalBenchmarkSummary = {
  scoredRegionCount: number;
  skippedRegionCount: number;
  avgCompositeScore: number;
  avgLineQuadIouMean: number;
  avgBlockHullIou: number;
  avgSourceQuadCoverage: number;
  avgFontSizeError: number;
  avgLineCenterDistanceNorm: number;
  avgLineWidthError: number;
  avgLineHeightError: number;
  avgLinePitchError: number;
  avgLineAngleErrorDeg: number;
  avgLineBreakF1: number;
  gtGlyphCount: number;
  predGlyphCount: number;
  matchedGlyphCount: number;
  positionedGlyphCount: number;
  glyphTextMatchCoverage: number;
  glyphPositionCoverage: number;
  signedCharDxNormMean: number;
  signedCharDyNormMean: number;
  charDxNormMean: number;
  charDyNormMean: number;
  charDistanceNormMean: number;
  charDistanceNormMedian: number;
  charDistanceNormP95: number;
  charDistanceNormMax: number;
  charDistanceOverHalfEmRate: number;
  charDistanceOverOneEmRate: number;
  avgCharAdvanceError: number;
  charCenterQuality: number;
};

export type BenchmarkSummary = {
  schemaVersion: 2;
  generatedAt: string;
  imageCount: number;
  totalRegionCount: number;
  skippedRegionCount: number;
  avgCompositeScore: number;
  avgGlyphQualityCoverage: number;
  avgGlyphOrientationAccuracy: number;
  avgRunContinuityRate: number;
  avgVerticalItemCenterAlignment: number;
  avgGlyphQualityScore: number;
  avgColumnIouMean: number;
  avgFontSizeError: number;
  avgSignedColumnDxNorm: number;
  avgColumnDxNorm: number;
  avgSignedColumnGapNorm: number;
  avgColumnPitchRatio: number;
  avgSignedCharDyNorm: number;
  avgCharDyNorm: number;
  avgSignedCharAdvanceNorm: number;
  avgCharAdvanceRatio: number;
  columnCountMatchRate: number;
  sourceGeometryUsableRegionCount: number;
  sourceGeometryRejectedRegionCount: number;
  sourceGeometrySpatialOrderMismatchCount: number;
  sourceGeometryRejectedReasons: Record<string, number>;
  horizontal: HorizontalBenchmarkSummary;
  images: ImageMetrics[];
};

export type ScoreWeights = {
  columnCountMatch: number;
  columnIouMean: number;
  fontSizeError: number;
  columnDxNorm: number;
  charDyNorm: number;
};

export type HorizontalScoreWeights = {
  lineCountMatch: number;
  lineQuadIouMean: number;
  blockHullIou: number;
  fontSizeError: number;
  lineBreakF1: number;
  glyphPositionCoverage: number;
  charCenterQuality: number;
};

export type BenchConfig = {
  fixturesDir: string;
  imagesDir: string;
  reportsDir: string;
  scoreWeights: ScoreWeights;
  horizontalScoreWeights: HorizontalScoreWeights;
  regressionThreshold: number;
};
