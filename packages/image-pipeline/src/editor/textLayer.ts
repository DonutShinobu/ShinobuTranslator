import type { PlatformProvider, PipelineCanvas } from '../runtime/platform';
import type { TextRegion } from '../types';
import { drawTypeset } from '../pipeline/typeset/drawTypeset';
import { canvasToPngBlob } from '../protocol/blobCodec';
import type { EditableTextLayer, TypesetLayerCanvas } from './types';

export async function encodeTextLayer(
  layer: TypesetLayerCanvas,
  encode: (canvas: PipelineCanvas) => Blob | Promise<Blob> = canvasToPngBlob,
): Promise<EditableTextLayer> {
  return {
    id: `text:${layer.region.id}`,
    regionId: layer.region.id,
    kind: 'text',
    image: await encode(layer.canvas),
    width: layer.canvas.width,
    height: layer.canvas.height,
    transform: [...layer.transform],
    quad: structuredClone(layer.quad),
    region: structuredClone(layer.region),
    ...(layer.layout ? { layout: structuredClone(layer.layout) } : {}),
  };
}

/** Uses the same layout and rasterization as the automatic typesetter. */
export async function renderEditableTextLayer(
  region: TextRegion,
  targetLang: string,
  platform: PlatformProvider,
): Promise<EditableTextLayer | null> {
  const scratch = platform.createCanvas(1, 1);
  let layer: TypesetLayerCanvas | undefined;
  let output: PipelineCanvas | undefined;
  try {
    const result = await drawTypeset(scratch, [region], targetLang, {
      onTextLayer: (value) => { layer = value; },
    }, platform);
    output = result.canvas;
    return layer ? await encodeTextLayer(layer) : null;
  } finally {
    for (const canvas of [scratch, output, layer?.canvas]) {
      if (canvas?.dispose) canvas.dispose();
      else if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }
}
