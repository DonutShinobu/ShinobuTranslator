import { describe, expect, it } from 'vitest';
import {
  createPipelineRecord,
  hasTranslatableText,
  recoverPipelineRecord,
  type PipelineRecordSource,
} from '@shinobu/image-pipeline';

const source: PipelineRecordSource = {
  image: { width: 800, height: 600 },
  ocr: [{
    id: 'ocr-1',
    box: { x: 10, y: 20, width: 30, height: 40 },
    sourceText: '原文',
    translatedText: '',
    prob: 0.95,
  }],
  ordered: [{
    id: 'translated-1',
    box: { x: 50, y: 60, width: 70, height: 80 },
    sourceText: '原文',
    translatedText: '译文',
    translatedColumns: ['译', '文'],
  }],
};

describe('pipeline processing record', () => {
  it('treats only non-blank ordered text as translatable', () => {
    expect(hasTranslatableText({
      ordered: [{
        id: 'blank',
        box: { x: 0, y: 0, width: 1, height: 1 },
        sourceText: ' \n ',
        translatedText: '',
      }],
    })).toBe(false);
    expect(hasTranslatableText(source)).toBe(true);
  });

  it('records source-native coordinates with an identity transform', () => {
    const record = createPipelineRecord(source, {
      strategy: 'source-native',
    });

    expect(record).toMatchObject({
      schemaVersion: 2,
      workingCopy: {
        width: 800,
        height: 600,
        spec: { strategy: 'source-native' },
        sourceToWorkingCopy: { kind: 'identity' },
      },
      ocr: [{
        id: 'ocr-1',
        order: 0,
        text: '原文',
      }],
      translations: [{
        id: 'translated-1',
        order: 0,
        sourceText: '原文',
        translatedText: '译文',
        translatedColumns: ['译', '文'],
      }],
    });
  });

  it('records normalized working-copy geometry and an explicit scale transform', () => {
    const record = createPipelineRecord(source, {
      strategy: 'normalized',
      sourceSize: { width: 1600, height: 1200 },
      size: { width: 800, height: 600 },
      imageOrientation: 'from-image',
      background: '#ffffff',
    });

    expect(record.workingCopy).toEqual({
      width: 800,
      height: 600,
      spec: {
        strategy: 'normalized',
        sourceSize: { width: 1600, height: 1200 },
        size: { width: 800, height: 600 },
        imageOrientation: 'from-image',
        background: '#ffffff',
      },
      sourceToWorkingCopy: {
        kind: 'scale',
        scaleX: 0.5,
        scaleY: 0.5,
      },
    });
    expect(() => createPipelineRecord(source, {
      strategy: 'source-native',
      apiKey: 'must-not-persist',
    } as never)).toThrowError(/工作副本规格结构无效/u);
  });

  it('recovers the current schema and fails closed on unknown future versions', () => {
    const record = createPipelineRecord(source, { strategy: 'source-native' });

    expect(recoverPipelineRecord(structuredClone(record))).toEqual(record);
    expect(() => recoverPipelineRecord({
      ...record,
      schemaVersion: 3,
    })).toThrowError(/不支持的流水线处理记录版本/u);
    expect(() => recoverPipelineRecord({
      ...record,
      apiKey: 'must-not-persist',
    })).toThrowError(/结构无效/u);
    expect(() => recoverPipelineRecord({
      ...record,
      ocr: record.ocr.map((entry) => ({
        ...entry,
        apiKey: 'must-not-persist',
      })),
    })).toThrowError(/结构无效/u);
  });

  it('fails closed when working-copy dimensions and transform disagree with the spec', () => {
    const record = createPipelineRecord(source, {
      strategy: 'normalized',
      sourceSize: { width: 1600, height: 1200 },
      size: { width: 800, height: 600 },
      imageOrientation: 'from-image',
      background: '#ffffff',
    });

    expect(() => recoverPipelineRecord({
      ...record,
      workingCopy: {
        ...record.workingCopy,
        width: 799,
      },
    })).toThrowError(/结构无效/u);
    expect(() => recoverPipelineRecord({
      ...record,
      workingCopy: {
        ...record.workingCopy,
        sourceToWorkingCopy: { kind: 'identity' },
      },
    })).toThrowError(/结构无效/u);
    expect(() => recoverPipelineRecord({
      ...record,
      workingCopy: {
        ...record.workingCopy,
        sourceToWorkingCopy: {
          kind: 'scale',
          scaleX: 0.25,
          scaleY: 0.5,
        },
      },
    })).toThrowError(/结构无效/u);

    const sourceNative = createPipelineRecord(source, { strategy: 'source-native' });
    expect(() => recoverPipelineRecord({
      ...sourceNative,
      workingCopy: {
        ...sourceNative.workingCopy,
        sourceToWorkingCopy: {
          kind: 'scale',
          scaleX: 1,
          scaleY: 1,
        },
      },
    })).toThrowError(/结构无效/u);
  });
});
