import {
  scaleScreenshotRectAroundPoint,
  toDocumentScreenshotRect,
  toViewportScreenshotRect,
} from '../screenshot';
import type { ScreenshotRect } from '../screenshot';
import type { ScreenshotResultUiElements } from '../ui';

type ContextImageAnchorRects = {
  documentRect: ScreenshotRect;
  visibleViewportRect: ScreenshotRect;
};

function toViewportRectFromDocumentRect(rect: ScreenshotRect): ScreenshotRect {
  return {
    left: rect.left - window.scrollX,
    top: rect.top - window.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

function toElementViewportRect(element: HTMLElement, fallbackDocumentRect: ScreenshotRect): ScreenshotRect {
  if (!element.isConnected) return toViewportRectFromDocumentRect(fallbackDocumentRect);
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return toViewportRectFromDocumentRect(fallbackDocumentRect);
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function resolveContextImageAnchorRects(
  element: HTMLImageElement,
  fallbackDocumentRect: ScreenshotRect,
): ContextImageAnchorRects {
  const viewportRect = toElementViewportRect(element, fallbackDocumentRect);
  return {
    documentRect: toDocumentScreenshotRect(viewportRect, window.scrollX, window.scrollY),
    visibleViewportRect: toViewportScreenshotRect(viewportRect, window.innerWidth, window.innerHeight),
  };
}

export function attachScreenshotResultDrag(ui: ScreenshotResultUiElements, onDetach?: () => void): () => void {
    let dragging = false;
    let pointerId: number | null = null;
    let startClientX = 0;
    let startClientY = 0;
    let startLeft = 0;
    let startTop = 0;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (
        event.button !== 0 ||
        (target instanceof Element && target.closest('button'))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onDetach?.();
      dragging = true;
      pointerId = event.pointerId;
      startClientX = event.clientX;
      startClientY = event.clientY;
      startLeft = Number.parseFloat(ui.host.style.left || '0');
      startTop = Number.parseFloat(ui.host.style.top || '0');
      ui.host.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging || pointerId !== event.pointerId) return;
      event.preventDefault();
      const nextLeft = startLeft + event.clientX - startClientX;
      const nextTop = startTop + event.clientY - startClientY;
      ui.host.style.left = `${nextLeft}px`;
      ui.host.style.top = `${nextTop}px`;
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!dragging || pointerId !== event.pointerId) return;
      event.preventDefault();
      dragging = false;
      pointerId = null;
      if (ui.host.hasPointerCapture(event.pointerId)) {
        ui.host.releasePointerCapture(event.pointerId);
      }
    };

    ui.host.addEventListener('pointerdown', onPointerDown);
    ui.host.addEventListener('pointermove', onPointerMove);
    ui.host.addEventListener('pointerup', onPointerUp);
    return () => {
      ui.host.removeEventListener('pointerdown', onPointerDown);
      ui.host.removeEventListener('pointermove', onPointerMove);
      ui.host.removeEventListener('pointerup', onPointerUp);
    };
  }

export function attachScreenshotResultZoom(
    ui: ScreenshotResultUiElements,
    onZoom: () => void,
    onDetach?: () => void,
  ): () => void {
    const minSize = 24;
    const maxSize = 60000;
    const zoomStep = 1.12;
    let zoomClassTimer: number | null = null;

    const scheduleZoomTransitionCleanup = (): void => {
      if (zoomClassTimer !== null) {
        window.clearTimeout(zoomClassTimer);
      }
      zoomClassTimer = window.setTimeout(() => {
        ui.host.classList.remove('mt-x-screenshot-result-zooming');
        zoomClassTimer = null;
      }, 260);
    };

    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      onDetach?.();
      ui.host.classList.add('mt-x-screenshot-result-zooming');
      const currentRect: ScreenshotRect = {
        left: Number.parseFloat(ui.host.style.left || '0'),
        top: Number.parseFloat(ui.host.style.top || '0'),
        width: Number.parseFloat(ui.host.style.width || `${ui.host.offsetWidth}`),
        height: Number.parseFloat(ui.host.style.height || `${ui.host.offsetHeight}`),
      };
      const scale = event.deltaY < 0 ? zoomStep : 1 / zoomStep;
      const nextRect = scaleScreenshotRectAroundPoint(
        currentRect,
        {
          left: window.scrollX + event.clientX,
          top: window.scrollY + event.clientY,
        },
        scale,
        minSize,
        maxSize,
      );
      ui.host.style.left = `${nextRect.left}px`;
      ui.host.style.top = `${nextRect.top}px`;
      ui.host.style.width = `${nextRect.width}px`;
      ui.host.style.height = `${nextRect.height}px`;
      onZoom();
      scheduleZoomTransitionCleanup();
    };

    ui.host.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      if (zoomClassTimer !== null) {
        window.clearTimeout(zoomClassTimer);
      }
      ui.host.classList.remove('mt-x-screenshot-result-zooming');
      ui.host.removeEventListener('wheel', onWheel);
    };
  }
