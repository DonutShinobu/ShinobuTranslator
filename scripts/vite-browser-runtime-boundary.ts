import type { Plugin } from 'vite';

export type BrowserRuntimeBoundaryPluginOptions = {
  apply?: 'serve' | 'build';
};

export function browserRuntimeBoundaryPlugin(
  options: BrowserRuntimeBoundaryPluginOptions = {},
): Plugin {
  const virtualPrefix = '\0shinobu-browser-node-adapter:';
  return {
    name: 'shinobu-browser-runtime-boundary',
    apply: options.apply,
    enforce: 'pre',
    resolveId(source) {
      if (source === './onnxNodeBridge') {
        return `${virtualPrefix}onnx`;
      }
      if (source === './modelRegistryNode') {
        return `${virtualPrefix}model-registry`;
      }
      if (source === './ocrSharedNode') {
        return `${virtualPrefix}ocr`;
      }
      return null;
    },
    load(id) {
      if (!id.startsWith(virtualPrefix)) return null;
      const unavailable = [
        'const unavailable = async () => {',
        '  throw new Error("Node runtime adapter is unavailable in a browser build");',
        '};',
      ].join('\n');
      if (id === `${virtualPrefix}onnx`) {
        return [
          unavailable,
          'export const createSession = unavailable;',
          'export const runInference = unavailable;',
          'export const probeRuntime = unavailable;',
          'export const runDetectWithGpuPreprocess = unavailable;',
          'export const disposeSession = unavailable;',
          'export const disposeAll = unavailable;',
        ].join('\n');
      }
      if (id === `${virtualPrefix}model-registry`) {
        return [
          unavailable,
          'export const loadManifestNode = unavailable;',
          'export const resolveModelFilePath = unavailable;',
        ].join('\n');
      }
      return [
        unavailable,
        'export const loadCharsetNode = unavailable;',
      ].join('\n');
    },
  };
}
