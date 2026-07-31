export const CONFORMANCE_FIELD_CLASSIFICATION = Object.freeze({
  strict: Object.freeze([
    'schemaVersion',
    'scenarioId',
    'request',
    'progress[].stage',
    'progress[].operation',
    'progress[].completed',
    'progress[].total',
    'progress[].retry',
    'result.status',
    'result.artifact.contentType',
    'result.artifact.width',
    'result.artifact.height',
    'result.artifact.channelOrder',
    'result.artifact.colorSpace',
    'result.artifact.inputEquivalentToSource',
    'result.record.schemaVersion',
    'result.record.workingCopy',
    'result.record.ocr[].order',
    'result.record.ocr[].direction',
    'result.record.ocr[].text',
    'result.record.translations[].order',
    'result.record.translations[].direction',
    'result.record.translations[].sourceText',
    'result.record.translations[].translatedText',
    'result.record.translations[].translatedColumns',
    'result.providerReports[]',
    'failure',
    'cancellation',
    'finalizationCount',
    'commitCount',
  ]),
  normalized: Object.freeze([
    'result.record.ocr[].id',
    'result.record.translations[].id',
  ]),
  tolerance: Object.freeze([
    'result.record.ocr[].confidence',
    'result.record.*[].box',
    'result.record.*[].quad',
    'result.typesetMetrics.font',
    'result.typesetMetrics.layout',
    'result.artifact.decodedRgbaBase64',
  ]),
  excluded: Object.freeze([
    'browser',
    'host',
    'progress[].detail',
    'result.artifact.byteLength',
    'result.artifact.nativeBytesSha256',
    'result.stageTimings',
    'failure.underlyingErrorText',
    'failure.stack',
  ]),
});

export type NumericObservationCategory =
  | 'confidence'
  | 'geometry'
  | 'quad'
  | 'font'
  | 'layout';

export type NumericObservation = Record<
  NumericObservationCategory,
  Readonly<Record<string, number>>
>;

export type NumericToleranceBudget = Record<NumericObservationCategory, number>;

export type DecodedRgbaImage = {
  width: number;
  height: number;
  channelOrder: 'rgba';
  colorSpace: 'srgb';
  data: Uint8Array;
};

export type PixelRoi = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RgbaMetricBudget = {
  maxMae: number;
  maxP99: number;
  maxP999: number;
  maxWorstTileMae: number;
  cumulativeMinimums: readonly {
    differenceAtMost: number;
    minimumRatio: number;
  }[];
};

export type RgbaToleranceBudget = {
  fullImage: RgbaMetricBudget;
  roi: RgbaMetricBudget;
  alpha: RgbaMetricBudget;
  strictAlpha?: boolean;
};

export type GoldenComparable = {
  strict: unknown;
  numeric: NumericObservation;
  rgba: DecodedRgbaImage;
};

export type GoldenEdgeBudget = {
  numeric: NumericToleranceBudget;
  rgba: RgbaToleranceBudget;
};

export type GoldenTriangleInput = {
  sample: {
    expectedStatus: 'completed' | 'no-translatable-text';
    alpha: 'opaque' | 'transparent';
  };
  chromeBaseline: GoldenComparable;
  firefoxBaseline: GoldenComparable;
  currentChrome: GoldenComparable;
  currentFirefox: GoldenComparable;
  processingRegions: readonly PixelRoi[];
  roiExpansionPixels: number;
  budgets: {
    chromeBaseline: GoldenEdgeBudget;
    firefoxBaseline: GoldenEdgeBudget;
    crossBrowser: GoldenEdgeBudget;
  };
};

export type GoldenEdgeComparisonReport = {
  matches: true;
  strict: { matches: true };
  numeric: NumericComparisonReport;
  rgba: RgbaComparisonReport;
};

export type GoldenTriangleComparisonReport = {
  matches: true;
  edges: {
    chromeBaseline: GoldenEdgeComparisonReport;
    firefoxBaseline: GoldenEdgeComparisonReport;
    crossBrowser: GoldenEdgeComparisonReport;
  };
};

export type NumericComparisonReport = {
  matches: true;
  maximumAbsoluteDifferences: Record<NumericObservationCategory, number>;
};

export class NumericToleranceExceededError extends Error {
  constructor(
    readonly category: NumericObservationCategory,
    readonly metric: string,
    readonly difference: number,
    readonly budget: number,
  ) {
    super(
      `numeric tolerance exceeded for ${category}.${metric}: `
      + `${difference} > ${budget}`,
    );
    this.name = 'NumericToleranceExceededError';
  }
}
export type RgbaDiffMetrics = {
  sampleCount: number;
  histogram: number[];
  cumulativeRatios: number[];
  mae: number;
  p99: number;
  p999: number;
  worstTileMae: number;
  maximumChannelDifference: number;
};

export type RgbaComparisonReport = {
  matches: true;
  fullImage: RgbaDiffMetrics;
  roi: RgbaDiffMetrics;
  alpha: RgbaDiffMetrics;
};

export class RgbaToleranceExceededError extends Error {
  constructor(
    readonly scope: 'fullImage' | 'roi' | 'alpha',
    readonly metric: string,
    readonly actual: number,
    readonly budget: number,
  ) {
    super(
      `RGBA tolerance exceeded for ${scope}.${metric}: ${actual} `
      + `${metric === 'cumulativeRatio' ? '<' : '>'} ${budget}`,
    );
    this.name = 'RgbaToleranceExceededError';
  }
}

export class GoldenTriangleMismatchError extends Error {
  constructor(
    readonly edge: keyof GoldenTriangleComparisonReport['edges'],
    readonly category: 'strict',
    readonly path: string,
  ) {
    super(`golden triangle ${edge} ${category} mismatch at ${path}`);
    this.name = 'GoldenTriangleMismatchError';
  }
}

const NUMERIC_CATEGORIES: readonly NumericObservationCategory[] = [
  'confidence',
  'geometry',
  'quad',
  'font',
  'layout',
];

function sortedKeys(record: Readonly<Record<string, number>>): string[] {
  return Object.keys(record).sort();
}

function assertFiniteNonNegative(value: number, path: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a finite non-negative number`);
  }
}

export function compareNumericObservations(
  reference: NumericObservation,
  candidate: NumericObservation,
  budget: NumericToleranceBudget,
): NumericComparisonReport {
  const maxima = {} as Record<NumericObservationCategory, number>;
  for (const category of NUMERIC_CATEGORIES) {
    const categoryBudget = budget[category];
    assertFiniteNonNegative(categoryBudget, `numeric budget.${category}`);
    const referenceKeys = sortedKeys(reference[category]);
    const candidateKeys = sortedKeys(candidate[category]);
    if (
      referenceKeys.length !== candidateKeys.length
      || referenceKeys.some((key, index) => key !== candidateKeys[index])
    ) {
      throw new TypeError(`numeric metric keys differ for ${category}`);
    }
    let maximum = 0;
    for (const key of referenceKeys) {
      const referenceValue = reference[category][key];
      const candidateValue = candidate[category][key];
      if (!Number.isFinite(referenceValue) || !Number.isFinite(candidateValue)) {
        throw new TypeError(`numeric metric ${category}.${key} must be finite`);
      }
      const difference = Math.abs(referenceValue - candidateValue);
      maximum = Math.max(maximum, difference);
      if (difference > categoryBudget) {
        throw new NumericToleranceExceededError(
          category,
          key,
          difference,
          categoryBudget,
        );
      }
    }
    maxima[category] = maximum;
  }
  return {
    matches: true,
    maximumAbsoluteDifferences: maxima,
  };
}

function validateRgbaImage(image: DecodedRgbaImage, path: string): void {
  if (
    !Number.isInteger(image.width)
    || image.width <= 0
    || !Number.isInteger(image.height)
    || image.height <= 0
  ) {
    throw new TypeError(`${path} dimensions must be positive integers`);
  }
  if (image.channelOrder !== 'rgba') {
    throw new TypeError(`${path} channel order must be rgba`);
  }
  if (image.colorSpace !== 'srgb') {
    throw new TypeError(`${path} color space must be srgb`);
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new TypeError(`${path} RGBA byte length does not match dimensions`);
  }
}

function validateRoi(roi: PixelRoi, index: number): void {
  const fields = Object.keys(roi).sort();
  if (fields.join(',') !== 'height,width,x,y') {
    throw new TypeError(`roi[${index}] fields must be exactly x, y, width, height`);
  }
  for (const [field, value] of Object.entries(roi)) {
    if (!Number.isInteger(value)) {
      throw new TypeError(`roi[${index}].${field} must be an integer`);
    }
  }
  if (roi.width <= 0 || roi.height <= 0) {
    throw new TypeError(`roi[${index}] dimensions must be positive`);
  }
}

function roiMask(
  width: number,
  height: number,
  rois: readonly PixelRoi[],
): Uint8Array {
  const selected = new Uint8Array(width * height);
  for (const [index, roi] of rois.entries()) {
    validateRoi(roi, index);
    const left = Math.max(0, roi.x);
    const top = Math.max(0, roi.y);
    const right = Math.min(width, roi.x + roi.width);
    const bottom = Math.min(height, roi.y + roi.height);
    for (let y = top; y < bottom; y += 1) {
      selected.fill(1, y * width + left, y * width + right);
    }
  }
  return selected;
}

function percentileFromHistogram(
  histogram: readonly number[],
  sampleCount: number,
  percentile: number,
): number {
  if (sampleCount === 0) return 0;
  const target = Math.ceil(sampleCount * percentile);
  let cumulative = 0;
  for (let difference = 0; difference < histogram.length; difference += 1) {
    cumulative += histogram[difference] ?? 0;
    if (cumulative >= target) return difference;
  }
  return 255;
}

function diffMetrics(
  reference: DecodedRgbaImage,
  candidate: DecodedRgbaImage,
  channels: readonly number[],
  selectedPixels: Uint8Array | null,
  tileSize: number,
): RgbaDiffMetrics {
  const histogram = Array.from({ length: 256 }, () => 0);
  const tilesAcross = Math.ceil(reference.width / tileSize);
  const tilesDown = Math.ceil(reference.height / tileSize);
  const tileSums = new Float64Array(tilesAcross * tilesDown);
  const tileCounts = new Uint32Array(tilesAcross * tilesDown);
  let sum = 0;
  let sampleCount = 0;
  let maximumChannelDifference = 0;

  for (let pixel = 0; pixel < reference.width * reference.height; pixel += 1) {
    if (selectedPixels && selectedPixels[pixel] !== 1) continue;
    const x = pixel % reference.width;
    const y = Math.floor(pixel / reference.width);
    const tileIndex = Math.floor(y / tileSize) * tilesAcross
      + Math.floor(x / tileSize);
    for (const channel of channels) {
      const offset = pixel * 4 + channel;
      const difference = Math.abs(
        (reference.data[offset] ?? 0) - (candidate.data[offset] ?? 0),
      );
      histogram[difference] = (histogram[difference] ?? 0) + 1;
      sum += difference;
      sampleCount += 1;
      maximumChannelDifference = Math.max(
        maximumChannelDifference,
        difference,
      );
      tileSums[tileIndex] = (tileSums[tileIndex] ?? 0) + difference;
      tileCounts[tileIndex] = (tileCounts[tileIndex] ?? 0) + 1;
    }
  }

  const cumulativeRatios: number[] = [];
  let cumulative = 0;
  for (const count of histogram) {
    cumulative += count;
    cumulativeRatios.push(sampleCount === 0 ? 1 : cumulative / sampleCount);
  }
  let worstTileMae = 0;
  for (let tile = 0; tile < tileSums.length; tile += 1) {
    const count = tileCounts[tile] ?? 0;
    if (count === 0) continue;
    worstTileMae = Math.max(worstTileMae, (tileSums[tile] ?? 0) / count);
  }
  return {
    sampleCount,
    histogram,
    cumulativeRatios,
    mae: sampleCount === 0 ? 0 : sum / sampleCount,
    p99: percentileFromHistogram(histogram, sampleCount, 0.99),
    p999: percentileFromHistogram(histogram, sampleCount, 0.999),
    worstTileMae,
    maximumChannelDifference,
  };
}

function assertMetricBudget(
  scope: 'fullImage' | 'roi' | 'alpha',
  metrics: RgbaDiffMetrics,
  budget: RgbaMetricBudget,
): void {
  const maxima = [
    ['mae', metrics.mae, budget.maxMae],
    ['p99', metrics.p99, budget.maxP99],
    ['p999', metrics.p999, budget.maxP999],
    ['worstTileMae', metrics.worstTileMae, budget.maxWorstTileMae],
  ] as const;
  for (const [name, actual, maximum] of maxima) {
    assertFiniteNonNegative(maximum, `RGBA budget.${scope}.${name}`);
    if (actual > maximum) {
      throw new RgbaToleranceExceededError(scope, name, actual, maximum);
    }
  }
  for (const [index, minimum] of budget.cumulativeMinimums.entries()) {
    if (
      !Number.isInteger(minimum.differenceAtMost)
      || minimum.differenceAtMost < 0
      || minimum.differenceAtMost > 255
    ) {
      throw new TypeError(
        `RGBA budget.${scope}.cumulativeMinimums[${index}] `
        + 'differenceAtMost must be an integer from 0 to 255',
      );
    }
    if (
      !Number.isFinite(minimum.minimumRatio)
      || minimum.minimumRatio < 0
      || minimum.minimumRatio > 1
    ) {
      throw new TypeError(
        `RGBA budget.${scope}.cumulativeMinimums[${index}] `
        + 'minimumRatio must be from 0 to 1',
      );
    }
    const actual = metrics.cumulativeRatios[minimum.differenceAtMost] ?? 0;
    if (actual < minimum.minimumRatio) {
      throw new RgbaToleranceExceededError(
        scope,
        'cumulativeRatio',
        actual,
        minimum.minimumRatio,
      );
    }
  }
}

export function compareRgbaImages(
  reference: DecodedRgbaImage,
  candidate: DecodedRgbaImage,
  rois: readonly PixelRoi[],
  budget: RgbaToleranceBudget,
): RgbaComparisonReport {
  validateRgbaImage(reference, 'reference');
  validateRgbaImage(candidate, 'candidate');
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new TypeError('RGBA image dimensions differ');
  }
  if (reference.channelOrder !== candidate.channelOrder) {
    throw new TypeError('RGBA image channel order differs');
  }
  if (reference.colorSpace !== candidate.colorSpace) {
    throw new TypeError('RGBA image color space differs');
  }
  const selectedRoiPixels = roiMask(reference.width, reference.height, rois);
  if (rois.length > 0 && !selectedRoiPixels.includes(1)) {
    throw new TypeError('ROI does not intersect the decoded image');
  }
  const fullImage = diffMetrics(reference, candidate, [0, 1, 2], null, 32);
  const roi = diffMetrics(
    reference,
    candidate,
    [0, 1, 2],
    selectedRoiPixels,
    32,
  );
  const alpha = diffMetrics(reference, candidate, [3], null, 32);
  assertMetricBudget('fullImage', fullImage, budget.fullImage);
  assertMetricBudget('roi', roi, budget.roi);
  assertMetricBudget('alpha', alpha, budget.alpha);
  if (budget.strictAlpha && alpha.maximumChannelDifference !== 0) {
    throw new RgbaToleranceExceededError(
      'alpha',
      'strictAlpha',
      alpha.maximumChannelDifference,
      0,
    );
  }
  return { matches: true, fullImage, roi, alpha };
}

export function firstDifference(
  reference: unknown,
  candidate: unknown,
  path = 'observation',
): string | null {
  if (Object.is(reference, candidate)) return null;
  if (
    reference === null
    || candidate === null
    || typeof reference !== 'object'
    || typeof candidate !== 'object'
  ) {
    return path;
  }
  if (Array.isArray(reference) || Array.isArray(candidate)) {
    if (!Array.isArray(reference) || !Array.isArray(candidate)) return path;
    if (reference.length !== candidate.length) return `${path}.length`;
    for (let index = 0; index < reference.length; index += 1) {
      const difference = firstDifference(
        reference[index],
        candidate[index],
        `${path}[${index}]`,
      );
      if (difference) return difference;
    }
    return null;
  }
  const referenceRecord = reference as Record<string, unknown>;
  const candidateRecord = candidate as Record<string, unknown>;
  const keys = [...new Set([
    ...Object.keys(referenceRecord),
    ...Object.keys(candidateRecord),
  ])].sort();
  for (const key of keys) {
    if (
      !Object.hasOwn(referenceRecord, key)
      || !Object.hasOwn(candidateRecord, key)
    ) {
      return `${path}.${key}`;
    }
    const difference = firstDifference(
      referenceRecord[key],
      candidateRecord[key],
      `${path}.${key}`,
    );
    if (difference) return difference;
  }
  return null;
}

function compareGoldenEdge(
  edge: keyof GoldenTriangleComparisonReport['edges'],
  reference: GoldenComparable,
  candidate: GoldenComparable,
  roi: readonly PixelRoi[],
  budget: GoldenEdgeBudget,
  strictAlpha: boolean,
): GoldenEdgeComparisonReport {
  const strictDifference = firstDifference(
    reference.strict,
    candidate.strict,
  );
  if (strictDifference) {
    throw new GoldenTriangleMismatchError(
      edge,
      'strict',
      strictDifference,
    );
  }
  return {
    matches: true,
    strict: { matches: true },
    numeric: compareNumericObservations(
      reference.numeric,
      candidate.numeric,
      budget.numeric,
    ),
    rgba: compareRgbaImages(
      reference.rgba,
      candidate.rgba,
      roi,
      strictAlpha ? { ...budget.rgba, strictAlpha: true } : budget.rgba,
    ),
  };
}

export function compareGoldenTriangle(
  input: GoldenTriangleInput,
): GoldenTriangleComparisonReport {
  const strictAlpha = input.sample.expectedStatus === 'no-translatable-text'
    && input.sample.alpha === 'transparent';
  if (
    !Number.isInteger(input.roiExpansionPixels)
    || input.roiExpansionPixels < 0
  ) {
    throw new TypeError('ROI expansion must be a non-negative integer');
  }
  if (
    input.sample.expectedStatus === 'completed'
    && input.processingRegions.length === 0
  ) {
    throw new TypeError('completed golden samples require processing regions');
  }
  const roi = input.processingRegions.map((region) => ({
    x: region.x - input.roiExpansionPixels,
    y: region.y - input.roiExpansionPixels,
    width: region.width + input.roiExpansionPixels * 2,
    height: region.height + input.roiExpansionPixels * 2,
  }));
  return {
    matches: true,
    edges: {
      chromeBaseline: compareGoldenEdge(
        'chromeBaseline',
        input.chromeBaseline,
        input.currentChrome,
        roi,
        input.budgets.chromeBaseline,
        strictAlpha,
      ),
      firefoxBaseline: compareGoldenEdge(
        'firefoxBaseline',
        input.firefoxBaseline,
        input.currentFirefox,
        roi,
        input.budgets.firefoxBaseline,
        strictAlpha,
      ),
      crossBrowser: compareGoldenEdge(
        'crossBrowser',
        input.currentChrome,
        input.currentFirefox,
        roi,
        input.budgets.crossBrowser,
        strictAlpha,
      ),
    },
  };
}
