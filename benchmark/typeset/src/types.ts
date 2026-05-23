export type GroundTruthCharCenter = {
  y: number;
};

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
};

export type FixtureRegion = {
  id: string;
  direction: "v" | "h";
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

export type RegionMetrics = {
  regionId: string;
  skipped: boolean;
  skipReason?: string;
  columnCountMatch: number;
  columnCountDiff: number;
  columnIouMean: number;
  columnIouMin: number;
  fontSizeRatio: number;
  fontSizeError: number;
  columnDxNormMean: number;
  columnDxNormMax: number;
  dTopNormMean: number;
  dBottomNormMean: number;
  heightRatioMean: number;
  charDyNormMean: number;
  charDyNormMax: number;
  charDyNormP95: number;
  compositeScore: number;
};

export type ImageMetrics = {
  imageFile: string;
  regionCount: number;
  skippedCount: number;
  regions: RegionMetrics[];
  avgCompositeScore: number;
};

export type BenchmarkSummary = {
  generatedAt: string;
  imageCount: number;
  totalRegionCount: number;
  skippedRegionCount: number;
  avgCompositeScore: number;
  avgColumnIouMean: number;
  avgFontSizeError: number;
  avgColumnDxNorm: number;
  avgCharDyNorm: number;
  columnCountMatchRate: number;
  images: ImageMetrics[];
};

export type ScoreWeights = {
  columnCountMatch: number;
  columnIouMean: number;
  fontSizeError: number;
  columnDxNorm: number;
  charDyNorm: number;
};

export type BenchConfig = {
  fixturesDir: string;
  imagesDir: string;
  reportsDir: string;
  scoreWeights: ScoreWeights;
  regressionThreshold: number;
};
