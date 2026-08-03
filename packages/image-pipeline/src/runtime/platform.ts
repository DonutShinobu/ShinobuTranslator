/**
 * Platform abstraction layer for pipeline Canvas/Image operations.
 *
 * Pipeline code uses ~20 methods from the Canvas API and a handful
 * of image/font helpers. Rather than mirroring the full HTML Canvas
 * interface (50+ methods), we define structural types covering only
 * the methods pipeline actually uses. This keeps the Node
 * implementation lightweight.
 */

// ---------------------------------------------------------------------------
// Structural types — only what pipeline uses
// ---------------------------------------------------------------------------

export interface PipelineCanvas {
  width: number;
  height: number;
  getContext(type: '2d', options?: CanvasRenderingContext2DSettings): PipelineRenderingContext | null;
  toDataURL(type?: string): string;
  toBlob?(
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number,
  ): void;
  convertToBlob?(options?: { type?: string; quality?: number }): Promise<Blob>;
  dispose?(): void;
}

export interface PipelineRenderingContext {
  // Drawing
  drawImage(source: any, ...args: number[]): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number): void;
  putImageData(data: PipelineImageData, dx: number, dy: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): PipelineImageData;
  createImageData(width: number, height: number): PipelineImageData;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;

  // Path
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;

  // State
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  setLineDash(segments: number[]): void;

  // Measurement
  measureText(text: string): PipelineTextMetrics;

  // Properties
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  globalCompositeOperation: string;
  lineWidth: number;
  font: string;
  globalAlpha: number;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  lineJoin: CanvasLineJoin;
  miterLimit: number;
  imageSmoothingEnabled: boolean;
}

export interface PipelineTextMetrics {
  width: number;
  // browser: actualBoundingBoxLeft/Right/Ascent/Descent, fontBoundingBox*
  // node-canvas: only width
  // Optional so that node-canvas (which only returns width) still satisfies
  // the structural type without extra stubs.
  actualBoundingBoxLeft?: number;
  actualBoundingBoxRight?: number;
  actualBoundingBoxAscent?: number;
  actualBoundingBoxDescent?: number;
  fontBoundingBoxAscent?: number;
  fontBoundingBoxDescent?: number;
}

export interface PipelineImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface PipelineImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  onload: ((ev: any) => any) | null;
  onerror: ((ev: any) => any) | null;
  close?(): void;
}

export type PipelineFontDescriptors = {
  style?: string;
  weight?: string;
};

// ---------------------------------------------------------------------------
// PlatformProvider — factory interface
// ---------------------------------------------------------------------------

export interface PlatformProvider {
  /** Create an empty canvas with the given dimensions. */
  createCanvas(width: number, height: number): PipelineCanvas;

  /** Create an empty image object. Set src, then wait for onload. */
  createImage(): PipelineImage;

  /** Load an image from a source (data URL, file path, etc.). */
  loadImage(src: string): Promise<PipelineImage>;

  /** Create a transferable bitmap for GPU preprocessing when supported. */
  createImageBitmap?(image: PipelineImage): Promise<ImageBitmap>;

  /** Create an ImageData object with the given dimensions. */
  createImageData(width: number, height: number): PipelineImageData;

  /** Register a font for canvas rendering. */
  registerFont(
    path: string,
    family: string,
    descriptors?: PipelineFontDescriptors,
  ): void;

  /** Wait for all registered fonts to be ready for rendering. */
  waitForFonts(): Promise<void>;
}
