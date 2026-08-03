import { describe, expect, it, vi } from 'vitest';
import {
  createExtensionModelAssetSource,
  createOriginModelAssetSource,
} from '../../packages/model-runtime/src/runtime/modelSource';

describe('model asset source Adapter contract', () => {
  it('resolves Web assets against the application origin and manifest', () => {
    const source = createOriginModelAssetSource('https://app.example.test/workbench');
    const manifest = source.manifestUrl();

    expect(manifest).toBe('https://app.example.test/models/models.json');
    expect(source.resolveAsset('/models/detector.onnx', manifest))
      .toBe('https://app.example.test/models/detector.onnx');
    expect(source.resolveAsset('./bubble.onnx', manifest))
      .toBe('https://app.example.test/models/bubble.onnx');
    expect(source.resolveAsset('https://cdn.example.test/model.onnx', manifest))
      .toBe('https://cdn.example.test/model.onnx');
  });

  it('uses the extension URL Adapter for root-relative packaged assets', () => {
    const getAssetUrl = vi.fn(
      (path: string) => `chrome-extension://extension-id/${path}`,
    );
    const source = createExtensionModelAssetSource(getAssetUrl);
    const manifest = source.manifestUrl();

    expect(manifest).toBe('chrome-extension://extension-id/models/models.json');
    expect(source.resolveAsset('/models/detector.onnx', manifest))
      .toBe('chrome-extension://extension-id/models/detector.onnx');
    expect(source.resolveAsset('./bubble.onnx', manifest))
      .toBe('chrome-extension://extension-id/models/bubble.onnx');
    expect(getAssetUrl).toHaveBeenCalledWith('models/detector.onnx');
  });
});
