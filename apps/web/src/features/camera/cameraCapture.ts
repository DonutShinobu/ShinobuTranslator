export const CAMERA_PREVIEW_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  // Xiaomi's Camera2 HAL can stall low-resolution third-party YUV streams.
  // An ideal 4K stream selects its stable preview path while still allowing
  // lower-capability cameras to negotiate down.
  aspectRatio: { ideal: 16 / 9 },
  width: { ideal: 3_840 },
};

type CameraCapabilityRange = {
  max?: number;
};

type CameraPhotoCapabilities = {
  imageWidth?: CameraCapabilityRange;
  imageHeight?: CameraCapabilityRange;
  fillLightMode?: readonly string[];
};

type CameraPhotoSettings = {
  imageWidth?: number;
  imageHeight?: number;
  fillLightMode?: string;
};

type CameraImageCapture = {
  getPhotoCapabilities?: () => Promise<CameraPhotoCapabilities>;
  takePhoto: (settings?: CameraPhotoSettings) => Promise<Blob>;
};

export type CameraImageCaptureConstructor = new (
  track: MediaStreamTrack,
) => CameraImageCapture;

type CaptureCameraPhotoOptions = {
  ImageCapture?: CameraImageCaptureConstructor;
  capturePreviewFrame: () => Promise<Blob>;
};

export type CameraPhotoResult = {
  blob: Blob;
  source: 'image-capture' | 'preview-frame';
};

export type CoverCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function calculateCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): CoverCrop {
  const dimensions = [sourceWidth, sourceHeight, viewportWidth, viewportHeight];
  if (dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('Camera and viewport dimensions must be positive.');
  }

  const sourceAspectRatio = sourceWidth / sourceHeight;
  const viewportAspectRatio = viewportWidth / viewportHeight;

  if (sourceAspectRatio > viewportAspectRatio) {
    const width = sourceHeight * viewportAspectRatio;
    return {
      x: (sourceWidth - width) / 2,
      y: 0,
      width,
      height: sourceHeight,
    };
  }

  const height = sourceWidth / viewportAspectRatio;
  return {
    x: 0,
    y: (sourceHeight - height) / 2,
    width: sourceWidth,
    height,
  };
}

function positiveFiniteMaximum(range: CameraCapabilityRange | undefined): number | undefined {
  const maximum = range?.max;
  return typeof maximum === 'number' && Number.isFinite(maximum) && maximum > 0
    ? maximum
    : undefined;
}

function isUsablePhoto(blob: Blob | undefined): blob is Blob {
  return Boolean(blob && blob.size > 0);
}

async function getMaximumPhotoSettings(
  imageCapture: CameraImageCapture,
): Promise<CameraPhotoSettings | undefined> {
  if (!imageCapture.getPhotoCapabilities) return undefined;

  try {
    const capabilities = await imageCapture.getPhotoCapabilities();
    const settings: CameraPhotoSettings = {};
    const imageWidth = positiveFiniteMaximum(capabilities.imageWidth);
    const imageHeight = positiveFiniteMaximum(capabilities.imageHeight);
    if (imageWidth) settings.imageWidth = imageWidth;
    if (imageHeight) settings.imageHeight = imageHeight;
    if (capabilities.fillLightMode?.includes('off')) {
      settings.fillLightMode = 'off';
    }
    return Object.keys(settings).length > 0 ? settings : undefined;
  } catch {
    return undefined;
  }
}

async function tryImageCapture(
  track: MediaStreamTrack,
  ImageCapture: CameraImageCaptureConstructor,
): Promise<Blob | undefined> {
  const imageCapture = new ImageCapture(track);
  const settings = await getMaximumPhotoSettings(imageCapture);

  if (settings) {
    try {
      const photo = await imageCapture.takePhoto(settings);
      if (isUsablePhoto(photo)) return photo;
    } catch {
      // Some Android camera drivers expose capabilities but reject photo settings.
    }
  }

  try {
    const photo = await imageCapture.takePhoto();
    return isUsablePhoto(photo) ? photo : undefined;
  } catch {
    return undefined;
  }
}

export async function captureCameraPhoto(
  track: MediaStreamTrack,
  options: CaptureCameraPhotoOptions,
): Promise<CameraPhotoResult> {
  if (options.ImageCapture) {
    try {
      const photo = await tryImageCapture(track, options.ImageCapture);
      if (photo) return { blob: photo, source: 'image-capture' };
    } catch {
      // Construction can fail on browsers with partial ImageCapture support.
    }
  }

  const previewFrame = await options.capturePreviewFrame();
  if (!isUsablePhoto(previewFrame)) {
    throw new Error('Camera returned an empty image.');
  }
  return { blob: previewFrame, source: 'preview-frame' };
}
