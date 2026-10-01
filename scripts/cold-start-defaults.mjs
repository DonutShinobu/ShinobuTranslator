// The Chromium preset validated by the full PNG cold-start benchmark.
// Explicit benchmark overrides remain possible; other targets keep their defaults.
export const chromiumColdStartFlags = [
  'Overlap', 'PixelFastPath', 'GpuCtc', 'EarlySessions', 'InpaintPixels',
  'InpaintDirectPixels', 'FontsAfterDetect', 'StructuredClone',
  'GpuPreprocessNoFence', 'SelectedFonts', 'DetectorBasicOptimization',
  'WorkerPng', 'PanelOverlap', 'FontBlobUrl', 'ImageBlobUrl', 'MaskPacked',
  'MaskNativeThreshold', 'MaskNativeThresholdGpu', 'EarlyInpaintAfterBubble',
  'DownloadBlob', 'ReuseGpuAvailability', 'AdapterOverlap',
  'GpuPreprocessAutoLayout', 'DetectorReadbackParallel', 'ModelPrefetch',
  'ShaderTemplates', 'ReuseShaderPipelines',
].map(name => `__shinobuColdStart${name}`);

export const chromiumColdStartBanner = chromiumColdStartFlags.map(name =>
  `if(globalThis.${name}===undefined)globalThis.${name}=true;`,
).join('');
