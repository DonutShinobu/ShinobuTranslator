import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Icon } from '../../icons';
import type { AppCopy } from '../../i18n';
import {
  CAMERA_PREVIEW_CONSTRAINTS,
  calculateCoverCrop,
  captureCameraPhoto,
} from './cameraCapture';
import type { ContinuousCameraRoundState } from './cameraRound';

type CameraAccessState =
  | { status: 'requesting' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

type ContinuousCameraProps = {
  copy: AppCopy;
  round: ContinuousCameraRoundState;
  onCapture: (file: File) => Promise<void>;
  onNext: () => void;
  onExit: () => void;
};

function stopMediaStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function describeCameraAccessError(copy: AppCopy, error: unknown): string {
  if (!window.isSecureContext) return copy.cameraSecureContext;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return copy.cameraPermissionDenied;
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return copy.cameraUnavailable;
    }
    if (error.name === 'NotReadableError' || error.name === 'AbortError') {
      return copy.cameraBusy;
    }
  }
  return error instanceof Error && error.message
    ? `${copy.cameraUnavailable}: ${error.message}`
    : copy.cameraUnavailable;
}

export function ContinuousCamera({
  copy,
  round,
  onCapture,
  onNext,
  onExit,
}: ContinuousCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestIdRef = useRef(0);
  const [access, setAccess] = useState<CameraAccessState>({ status: 'requesting' });
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string>();

  const startCamera = useCallback(async (): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    setAccess({ status: 'requesting' });
    setCaptureError(undefined);

    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new DOMException(copy.cameraSecureContext, 'SecurityError');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: CAMERA_PREVIEW_CONSTRAINTS,
      });
      if (requestIdRef.current !== requestId) {
        stopMediaStream(stream);
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      const track = stream.getVideoTracks()[0];
      track?.addEventListener('ended', () => {
        if (requestIdRef.current === requestId) {
          setAccess({ status: 'error', message: copy.cameraInterrupted });
        }
      }, { once: true });
      setAccess({ status: 'ready' });
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setAccess({
        status: 'error',
        message: describeCameraAccessError(copy, error),
      });
    }
  }, [copy]);

  useEffect(() => {
    void startCamera();
    return () => {
      requestIdRef.current += 1;
      stopMediaStream(streamRef.current);
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [startCamera]);

  useEffect(() => {
    if (round.status === 'ready') {
      setCaptureBusy(false);
      setCaptureError(undefined);
      void videoRef.current?.play().catch(() => undefined);
    }
  }, [round.status]);

  const capture = async (): Promise<void> => {
    const video = videoRef.current;
    if (
      captureBusy
      || access.status !== 'ready'
      || round.status !== 'ready'
      || !video
    ) {
      return;
    }
    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      setCaptureError(copy.cameraNotReady);
      return;
    }

    setCaptureBusy(true);
    setCaptureError(undefined);
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') {
        throw new Error(copy.cameraNotReady);
      }
      const photo = await captureCameraPhoto(track, {
        capturePreviewFrame: async () => {
          const viewportWidth = video.clientWidth || window.innerWidth;
          const viewportHeight = video.clientHeight || window.innerHeight;
          const crop = calculateCoverCrop(
            video.videoWidth,
            video.videoHeight,
            viewportWidth,
            viewportHeight,
          );
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(crop.width));
          canvas.height = Math.max(1, Math.round(crop.height));
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error(copy.cameraCaptureFailed);
          context.drawImage(
            video,
            crop.x,
            crop.y,
            crop.width,
            crop.height,
            0,
            0,
            canvas.width,
            canvas.height,
          );
          const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (value) => value
                ? resolve(value)
                : reject(new Error(copy.cameraCaptureFailed)),
              'image/jpeg',
              0.94,
            );
          });
          canvas.width = 0;
          canvas.height = 0;
          return blob;
        },
      });
      const mimeType = photo.blob.type || 'image/jpeg';
      const extension = mimeType === 'image/png' ? 'png' : 'jpg';
      const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
      await onCapture(new File(
        [photo.blob],
        `shinobu-camera-${timestamp}.${extension}`,
        { type: mimeType, lastModified: Date.now() },
      ));
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : copy.cameraCaptureFailed);
    } finally {
      setCaptureBusy(false);
    }
  };

  const processing = round.status === 'preparing' || round.status === 'translating';
  const displayedImage = round.status === 'done'
    ? round.resultUrl
    : round.status !== 'ready'
      ? round.originalUrl
      : undefined;

  return (
    <section
      className="continuous-camera"
      role="dialog"
      aria-modal="true"
      aria-label={copy.continuousCamera}
      data-round-status={round.status}
    >
      <video
        ref={videoRef}
        className="continuous-camera-video"
        autoPlay
        muted
        playsInline
        aria-label={copy.cameraViewfinder}
      />

      <button
        className="continuous-camera-icon-button continuous-camera-back"
        type="button"
        aria-label={copy.cameraExit}
        title={copy.cameraExit}
        onClick={onExit}
      >
        <Icon name="back" weight="bold" />
      </button>

      {round.status === 'ready' && access.status === 'ready' && (
        <footer className="continuous-camera-controls">
          <button
            className="continuous-camera-shutter"
            type="button"
            aria-label={copy.cameraCaptureTranslate}
            disabled={captureBusy}
            onClick={() => void capture()}
          >
            <span aria-hidden="true" />
          </button>
          {captureError && (
            <span className="continuous-camera-capture-error" role="alert">
              {captureError}
            </span>
          )}
        </footer>
      )}

      {round.status === 'ready' && access.status === 'requesting' && (
        <div className="continuous-camera-loading" aria-live="polite">
          <span aria-hidden="true" />
          <strong className="visually-hidden">{copy.cameraStarting}</strong>
        </div>
      )}

      {round.status === 'ready' && access.status === 'error' && (
        <div className="continuous-camera-message" role="alert">
          <Icon name="warning" />
          <strong>{copy.cameraAccessFailed}</strong>
          <span>{access.message}</span>
          <button
            className="button button-primary"
            type="button"
            onClick={() => void startCamera()}
          >
            <Icon name="refresh" />
            {copy.cameraRetry}
          </button>
        </div>
      )}

      {displayedImage && (
        <div className="continuous-camera-round">
          <img
            src={displayedImage}
            alt={round.status === 'done' ? copy.cameraTranslatedPage : copy.cameraCapturedPage}
          />
          {processing && (
            <div className="continuous-camera-processing" aria-live="polite">
              <span className="continuous-camera-processing-bar" aria-hidden="true" />
              <strong>
                {round.status === 'preparing'
                  ? copy.cameraPreparing
                  : copy.cameraTranslating}
              </strong>
              <span>{round.detail}</span>
            </div>
          )}
          {round.status === 'done' && (
            <button
              className="continuous-camera-next"
              type="button"
              onClick={onNext}
            >
              <Icon name="camera" weight="bold" />
              <span>{copy.cameraNextPage}</span>
            </button>
          )}
          {round.status === 'error' && (
            <>
              <div className="continuous-camera-message" role="alert">
                <Icon name="warning" />
                <strong>{copy.cameraTranslationFailed}</strong>
                <span>{round.error}</span>
              </div>
              <button
                className="continuous-camera-next"
                type="button"
                onClick={onNext}
              >
                <Icon name="camera" weight="bold" />
                <span>{copy.cameraNextPage}</span>
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
