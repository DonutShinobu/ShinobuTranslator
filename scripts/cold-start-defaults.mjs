// The Chromium preset validated by the full PNG cold-start benchmark.
// Explicit benchmark overrides remain possible for both browser presets.
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

// Firefox keeps chunked layers; native thresholding and Chromium shader warmup
// had no usable benefit in the native Firefox validation.
export const firefoxColdStartFlags = chromiumColdStartFlags.filter(name => ![
  'StructuredClone', 'MaskNativeThreshold', 'MaskNativeThresholdGpu',
  'ShaderTemplates', 'ReuseShaderPipelines',
].includes(name.replace('__shinobuColdStart', '')));

const banner = flags => flags.map(name =>
  `if(globalThis.${name}===undefined)globalThis.${name}=true;`,
).join('');
export const chromiumColdStartBanner = banner(chromiumColdStartFlags);
export const firefoxColdStartBanner = banner(firefoxColdStartFlags);

// Inject after minification so browser defaults do not change shared code.
const plugin = (target, preset) => ({
  name: `${target}-cold-start-defaults`,
  apply: 'build',
  generateBundle: {
    order: 'post',
    handler(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') chunk.code = `${preset}\n${chunk.code}`;
      }
    },
  },
});
export const chromiumColdStartPlugin = plugin('chromium', chromiumColdStartBanner);
export const firefoxColdStartPlugin = plugin('firefox', firefoxColdStartBanner);
