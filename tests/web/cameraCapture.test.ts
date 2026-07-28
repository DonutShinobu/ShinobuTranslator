import { describe, expect, it, vi } from 'vitest';
import {
  CAMERA_PREVIEW_CONSTRAINTS,
  calculateCoverCrop,
  captureCameraPhoto,
  type CameraImageCaptureConstructor,
} from '../../apps/web/src/features/camera/cameraCapture';

function makeBlob(size = 4, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

describe('continuous camera capture', () => {
  it('requests the stable standard-4K rear-camera preview path', () => {
    expect(CAMERA_PREVIEW_CONSTRAINTS).toEqual({
      facingMode: { ideal: 'environment' },
      aspectRatio: { ideal: 16 / 9 },
      width: { ideal: 3_840 },
    });
  });

  it('crops the preview to the full-screen viewport aspect ratio', () => {
    expect(calculateCoverCrop(2_160, 3_840, 1_080, 2_400)).toEqual({
      x: 216,
      y: 0,
      width: 1_728,
      height: 3_840,
    });

    expect(calculateCoverCrop(3_840, 2_160, 2_400, 1_080)).toEqual({
      x: 0,
      y: 216,
      width: 3_840,
      height: 1_728,
    });
  });

  it('rejects invalid crop dimensions', () => {
    expect(() => calculateCoverCrop(0, 2_160, 1_080, 2_400)).toThrow(RangeError);
  });

  it('prefers a maximum-resolution still photo over the preview frame', async () => {
    const takePhoto = vi.fn(async () => makeBlob(16));
    const getPhotoCapabilities = vi.fn(async () => ({
      imageWidth: { min: 1_920, max: 4_096 },
      imageHeight: { min: 1_080, max: 3_072 },
      fillLightMode: ['off', 'auto', 'flash'],
    }));
    const ImageCapture = vi.fn(function MockImageCapture() {
      return { getPhotoCapabilities, takePhoto };
    }) as unknown as CameraImageCaptureConstructor;
    const fallback = vi.fn(async () => makeBlob(8));
    const track = {} as MediaStreamTrack;

    const result = await captureCameraPhoto(track, {
      ImageCapture,
      capturePreviewFrame: fallback,
    });

    expect(ImageCapture).toHaveBeenCalledWith(track);
    expect(takePhoto).toHaveBeenCalledWith({
      imageWidth: 4_096,
      imageHeight: 3_072,
      fillLightMode: 'off',
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: 'image-capture' });
    expect(result.blob.size).toBe(16);
  });

  it('retries without photo settings before falling back to a preview frame', async () => {
    const stillPhoto = makeBlob(12);
    const takePhoto = vi.fn()
      .mockRejectedValueOnce(new Error('settings not supported'))
      .mockResolvedValueOnce(stillPhoto);
    const ImageCapture = vi.fn(function MockImageCapture() {
      return {
        getPhotoCapabilities: vi.fn(async () => ({
          imageWidth: { max: 4_096 },
          imageHeight: { max: 3_072 },
        })),
        takePhoto,
      };
    }) as unknown as CameraImageCaptureConstructor;
    const fallback = vi.fn(async () => makeBlob(8));

    const result = await captureCameraPhoto({} as MediaStreamTrack, {
      ImageCapture,
      capturePreviewFrame: fallback,
    });

    expect(takePhoto).toHaveBeenCalledTimes(2);
    expect(takePhoto).toHaveBeenLastCalledWith();
    expect(fallback).not.toHaveBeenCalled();
    expect(result).toEqual({ blob: stillPhoto, source: 'image-capture' });
  });

  it('falls back to the preview frame when ImageCapture is unavailable or fails', async () => {
    const fallbackBlob = makeBlob(8);
    const fallback = vi.fn(async () => fallbackBlob);

    await expect(captureCameraPhoto({} as MediaStreamTrack, {
      capturePreviewFrame: fallback,
    })).resolves.toEqual({
      blob: fallbackBlob,
      source: 'preview-frame',
    });

    const ImageCapture = vi.fn(function MockImageCapture() {
      return {
        takePhoto: vi.fn(async () => {
          throw new Error('camera driver failed');
        }),
      };
    }) as unknown as CameraImageCaptureConstructor;

    await expect(captureCameraPhoto({} as MediaStreamTrack, {
      ImageCapture,
      capturePreviewFrame: fallback,
    })).resolves.toEqual({
      blob: fallbackBlob,
      source: 'preview-frame',
    });
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});
