import { describe, expect, it, vi } from 'vitest';
import { disposePipelineArtifacts } from '../../src/pipeline/resources';
import type {
  PipelineCanvas,
  PipelineImage,
} from '../../src/runtime/platform';
import type {
  BubbleMask,
  PipelineArtifacts,
  TextRegion,
} from '../../src/types';

function createCanvas(dispose: () => void): PipelineCanvas {
  return {
    width: 100,
    height: 100,
    getContext: () => null,
    toDataURL: () => '',
    dispose,
  };
}

function createRegion(mask: BubbleMask): TextRegion {
  return {
    id: 'region',
    box: { x: 0, y: 0, width: 1, height: 1 },
    sourceText: '原文',
    translatedText: '译文',
    bubbleMask: mask,
  };
}

describe('pipeline artifact resource ownership', () => {
  it('releases duplicate canvases once and drops retained masks', () => {
    const dispose = vi.fn();
    const close = vi.fn();
    const canvas = createCanvas(dispose);
    const image: PipelineImage = {
      src: '',
      naturalWidth: 100,
      naturalHeight: 100,
      onload: null,
      onerror: null,
      close,
    };
    const mask: BubbleMask = {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      data: new Uint8Array([1]),
    };
    const finalRegion = createRegion(mask);
    const stageRegion = createRegion(mask);
    const artifacts: PipelineArtifacts = {
      original: image,
      detectedRegions: [finalRegion],
      stageRegions: {
        detected: [stageRegion],
        ocr: [],
        merged: [],
        ordered: [],
      },
      detectionCanvas: canvas,
      ocrCanvas: canvas,
      segmentationCanvas: canvas,
      cleanedCanvas: canvas,
      resultCanvas: canvas,
      debugOriginalCanvas: canvas,
      typesetDebugLog: null,
      translationDebug: null,
      ocrDebug: null,
      ocrPostFilterDebug: null,
      runtimeStages: [],
      stageTimings: [],
    };

    disposePipelineArtifacts(artifacts);

    expect(dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(finalRegion.bubbleMask).toBeUndefined();
    expect(stageRegion.bubbleMask).toBeUndefined();
  });
});
