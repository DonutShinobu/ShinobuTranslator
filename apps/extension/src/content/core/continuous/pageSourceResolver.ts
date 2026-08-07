import { cropScreenshotToFile } from '../screenshot';
import type { ScreenshotRect } from '../screenshot';
import type { ReaderPageSurface } from './contracts';
import {
  RuntimeVisibleTabCapturePort,
  type VisibleTabCapturePort,
} from './visibleTabCapturePort';

export type ResolvedPageSource = {
  surface: ReaderPageSurface;
  file: File;
};

type PageSourceResolverDependencies = {
  capture?: VisibleTabCapturePort;
  crop?: (
    dataUrl: string,
    rect: ScreenshotRect,
    viewport: { width: number; height: number },
  ) => Promise<File>;
  hideExtensionUi?: () => () => void;
  waitForNextPaint?: () => Promise<void>;
  isDocumentVisible?: () => boolean;
};

function canvasSnapshot(canvas: HTMLCanvasElement, pageIndex: number): Promise<File | null> {
  if (!canvas.isConnected || canvas.width <= 0 || canvas.height <= 0) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => {
        resolve(blob
          ? new File([blob], `page-${pageIndex + 1}.png`, { type: 'image/png' })
          : null);
      }, 'image/png');
    } catch {
      resolve(null);
    }
  });
}

function waitForTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function hideContinuousUi(): () => void {
  const elements = [...document.querySelectorAll<HTMLElement>(
    '[data-mt-continuous-ui], [data-mt-continuous-projection]',
  )];
  const previous = elements.map((element) => element.style.visibility);
  elements.forEach((element) => {
    element.style.visibility = 'hidden';
  });
  return () => {
    elements.forEach((element, index) => {
      element.style.visibility = previous[index];
    });
  };
}

export class PageSourceResolver {
  private readonly capture: VisibleTabCapturePort;
  private readonly crop: NonNullable<PageSourceResolverDependencies['crop']>;
  private readonly hideExtensionUi: () => () => void;
  private readonly waitForNextPaint: () => Promise<void>;
  private readonly isDocumentVisible: () => boolean;

  constructor(dependencies: PageSourceResolverDependencies = {}) {
    this.capture = dependencies.capture ?? new RuntimeVisibleTabCapturePort();
    this.crop = dependencies.crop ?? cropScreenshotToFile;
    this.hideExtensionUi = dependencies.hideExtensionUi ?? hideContinuousUi;
    this.waitForNextPaint = dependencies.waitForNextPaint ?? waitForTwoFrames;
    this.isDocumentVisible = dependencies.isDocumentVisible
      ?? (() => document.visibilityState === 'visible');
  }

  async resolve(pages: readonly ReaderPageSurface[]): Promise<ResolvedPageSource[]> {
    const exported: ResolvedPageSource[] = [];
    let canvasExportFailed = false;
    for (const surface of pages) {
      if (surface.source.kind !== 'canvas') {
        canvasExportFailed = true;
        break;
      }
      const file = await canvasSnapshot(surface.source.element, surface.identity.pageIndex);
      if (!file) {
        canvasExportFailed = true;
        break;
      }
      exported.push({ surface, file });
    }
    if (!canvasExportFailed && exported.length === pages.length) return exported;
    if (!this.isDocumentVisible()) {
      throw new Error('页面位于后台，暂时无法截图');
    }

    const restore = this.hideExtensionUi();
    let capture;
    try {
      await this.waitForNextPaint();
      capture = await this.capture.capture();
    } finally {
      restore();
    }
    const resolved: ResolvedPageSource[] = [];
    for (const surface of pages) {
      const cropped = await this.crop(capture.dataUrl, surface.viewportRect, capture.viewport);
      resolved.push({
        surface,
        file: new File(
          [cropped],
          `page-${surface.identity.pageIndex + 1}.png`,
          { type: cropped.type || 'image/png' },
        ),
      });
    }
    return resolved;
  }
}
