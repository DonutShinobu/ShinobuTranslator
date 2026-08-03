import type { PipelineArtifacts } from '../types';
import type { PipelineCanvas } from '../runtime/platform';

function releaseCanvas(canvas: PipelineCanvas): void {
  if (canvas.dispose) {
    canvas.dispose();
    return;
  }
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Releases all image resources retained by a completed pipeline result.
 *
 * Artifact summaries and exported blobs must be created before calling this
 * function. Duplicate canvas references are released only once.
 */
export function disposePipelineArtifacts(artifacts: PipelineArtifacts): void {
  const canvases = new Set<PipelineCanvas>([
    artifacts.detectionCanvas,
    artifacts.ocrCanvas,
    artifacts.cleanedCanvas,
    artifacts.resultCanvas,
  ]);
  if (artifacts.segmentationCanvas) canvases.add(artifacts.segmentationCanvas);
  if (artifacts.debugOriginalCanvas) canvases.add(artifacts.debugOriginalCanvas);

  for (const canvas of canvases) {
    releaseCanvas(canvas);
  }
  artifacts.original.close?.();

  for (const region of artifacts.detectedRegions) {
    region.bubbleMask = undefined;
  }
  for (const regions of Object.values(artifacts.stageRegions)) {
    for (const region of regions) {
      region.bubbleMask = undefined;
    }
  }
}
