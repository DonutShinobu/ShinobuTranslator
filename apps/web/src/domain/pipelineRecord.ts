import type {
  PipelineArtifacts,
  QuadPoint,
  Rect,
  TextDirection,
  TextRegion,
} from '../../../../src/types';

export const WEB_PIPELINE_RECORD_SCHEMA_VERSION = 1 as const;

export type WebPipelineOcrRecord = {
  id: string;
  order: number;
  box: Rect;
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  direction?: TextDirection;
  confidence?: number;
  text: string;
};

export type WebPipelineTranslationRecord = {
  id: string;
  order: number;
  box: Rect;
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  direction?: TextDirection;
  sourceText: string;
  translatedText: string;
  translatedColumns?: string[];
};

export type WebPipelineRecord = {
  schemaVersion: typeof WEB_PIPELINE_RECORD_SCHEMA_VERSION;
  image: {
    width: number;
    height: number;
  };
  ocr: WebPipelineOcrRecord[];
  translations: WebPipelineTranslationRecord[];
};

type PipelineRecordArtifacts = Pick<PipelineArtifacts, 'original' | 'stageRegions'>;

function cloneBox(box: Rect): Rect {
  return { ...box };
}

function cloneQuad(
  quad: TextRegion['quad'],
): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] | undefined {
  if (!quad) return undefined;
  return quad.map((point) => ({ ...point })) as [
    QuadPoint,
    QuadPoint,
    QuadPoint,
    QuadPoint,
  ];
}

export function createWebPipelineRecord(
  artifacts: PipelineRecordArtifacts,
): WebPipelineRecord {
  return {
    schemaVersion: WEB_PIPELINE_RECORD_SCHEMA_VERSION,
    image: {
      width: artifacts.original.naturalWidth,
      height: artifacts.original.naturalHeight,
    },
    ocr: artifacts.stageRegions.ocr.map((region, order) => ({
      id: region.id,
      order,
      box: cloneBox(region.box),
      quad: cloneQuad(region.quad),
      direction: region.direction,
      confidence: region.prob,
      text: region.sourceText,
    })),
    translations: artifacts.stageRegions.ordered.map((region, order) => ({
      id: region.id,
      order,
      box: cloneBox(region.box),
      quad: cloneQuad(region.quad),
      direction: region.direction,
      sourceText: region.sourceText,
      translatedText: region.translatedText,
      translatedColumns: region.translatedColumns
        ? [...region.translatedColumns]
        : undefined,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBox(value: unknown): value is Rect {
  return isRecord(value)
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && value.width >= 0
    && isFiniteNumber(value.height)
    && value.height >= 0;
}

function isQuad(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value)
    && value.length === 4
    && value.every((point) =>
      isRecord(point) && isFiniteNumber(point.x) && isFiniteNumber(point.y))
  );
}

function isDirection(value: unknown): boolean {
  return value === undefined || value === 'h' || value === 'v';
}

function isOrderedBase(value: unknown, index: number): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && value.order === index
    && isBox(value.box)
    && isQuad(value.quad)
    && isDirection(value.direction);
}

export function isWebPipelineRecord(value: unknown): value is WebPipelineRecord {
  if (
    !isRecord(value)
    || value.schemaVersion !== WEB_PIPELINE_RECORD_SCHEMA_VERSION
    || !isRecord(value.image)
    || !Number.isSafeInteger(value.image.width)
    || (value.image.width as number) <= 0
    || !Number.isSafeInteger(value.image.height)
    || (value.image.height as number) <= 0
    || !Array.isArray(value.ocr)
    || !Array.isArray(value.translations)
    || value.ocr.length > 10_000
    || value.translations.length > 10_000
  ) {
    return false;
  }

  const ocrValid = value.ocr.every((entry, index) =>
    isOrderedBase(entry, index)
    && typeof entry.text === 'string'
    && entry.text.length <= 100_000
    && (
      entry.confidence === undefined
      || (isFiniteNumber(entry.confidence) && entry.confidence >= 0)
    ));
  const translationsValid = value.translations.every((entry, index) =>
    isOrderedBase(entry, index)
    && typeof entry.sourceText === 'string'
    && entry.sourceText.length <= 100_000
    && typeof entry.translatedText === 'string'
    && entry.translatedText.length <= 100_000
    && (
      entry.translatedColumns === undefined
      || (
        Array.isArray(entry.translatedColumns)
        && entry.translatedColumns.length <= 1_000
        && entry.translatedColumns.every(
          (column) => typeof column === 'string' && column.length <= 100_000,
        )
      )
    ));
  return ocrValid && translationsValid;
}
