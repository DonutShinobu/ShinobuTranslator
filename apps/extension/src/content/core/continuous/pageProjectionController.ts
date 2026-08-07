import type { PageArtifactPort } from './pageArtifactPort';
import type { ReaderPageSurface, ReaderVisibleSpread } from './contracts';
import type {
  ContinuousTranslationDisplayMode,
  ContinuousTranslationResult,
  PageProjectionPort,
} from './continuousTranslationController';
import { contentFingerprintsMatch } from './contentFingerprint';

type ProjectionDependencies = {
  createImage?: () => HTMLImageElement;
  urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  createResizeObserver?: (callback: ResizeObserverCallback) => ResizeObserver;
};

type MountedProjection = {
  image: HTMLImageElement;
  url: string;
  artifactId: string;
  surface: ReaderPageSurface;
  resizeObserver: ResizeObserver | null;
};

function projectionKey(surface: ReaderPageSurface): string {
  const { engineId, contextKey, pageIndex } = surface.identity;
  return `${engineId}:${contextKey}:${pageIndex}`;
}

function sameIdentity(
  surface: ReaderPageSurface,
  result: ContinuousTranslationResult,
): boolean {
  return surface.identity.engineId === result.identity.engineId
    && surface.identity.contextKey === result.identity.contextKey
    && surface.identity.pageIndex === result.identity.pageIndex;
}

export class PageProjectionController implements PageProjectionPort {
  private readonly createImage: () => HTMLImageElement;
  private readonly urlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  private readonly createResizeObserver: ((callback: ResizeObserverCallback) => ResizeObserver) | null;
  private readonly mounted = new Map<string, MountedProjection>();
  private displayMode: ContinuousTranslationDisplayMode = 'translated';
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly artifacts: PageArtifactPort,
    dependencies: ProjectionDependencies = {},
  ) {
    this.createImage = dependencies.createImage ?? (() => document.createElement('img'));
    this.urlApi = dependencies.urlApi ?? URL;
    this.createResizeObserver = dependencies.createResizeObserver
      ?? (typeof ResizeObserver === 'undefined'
        ? null
        : (callback) => new ResizeObserver(callback));
  }

  async sync(
    spread: ReaderVisibleSpread,
    results: readonly ContinuousTranslationResult[],
    currentFingerprints: ReadonlyMap<string, string> = new Map(),
  ): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    const desired = new Map<string, {
      surface: ReaderPageSurface;
      result: ContinuousTranslationResult;
    }>();
    if (this.displayMode === 'translated') {
      for (const surface of spread.pages) {
        const key = projectionKey(surface);
        const current = currentFingerprints.get(key);
        if (!current) continue;
        const result = [...results].reverse().find((candidate) => (
          sameIdentity(surface, candidate)
          && contentFingerprintsMatch(current, candidate.fingerprint)
        ));
        if (result) desired.set(key, { surface, result });
      }
    }

    for (const [key, projection] of this.mounted) {
      if (!desired.has(key)) this.removeProjection(key, projection);
    }
    for (const [key, target] of desired) {
      const existing = this.mounted.get(key);
      if (existing?.artifactId === target.result.artifact.id) {
        existing.surface = target.surface;
        target.surface.projectionAnchor.appendChild(existing.image);
        this.layout(existing);
        continue;
      }
      if (existing) this.removeProjection(key, existing);
      const file = await this.artifacts.read(target.result.artifact);
      if (
        this.disposed
        || generation !== this.generation
        || this.displayMode !== 'translated'
      ) {
        return;
      }
      const image = this.createImage();
      const url = this.urlApi.createObjectURL(file);
      image.dataset.mtContinuousProjection = '';
      image.alt = '';
      image.src = url;
      image.style.position = 'absolute';
      image.style.pointerEvents = 'none';
      image.style.zIndex = '2';
      image.style.objectFit = 'fill';
      const projection: MountedProjection = {
        image,
        url,
        artifactId: target.result.artifact.id,
        surface: target.surface,
        resizeObserver: null,
      };
      projection.resizeObserver = this.createResizeObserver?.(() => this.layout(projection)) ?? null;
      projection.resizeObserver?.observe(target.surface.projectionAnchor);
      if (target.surface.source.kind !== 'viewport-region') {
        projection.resizeObserver?.observe(target.surface.source.element);
      }
      target.surface.projectionAnchor.appendChild(image);
      this.mounted.set(key, projection);
      this.layout(projection);
    }
  }

  setDisplayMode(mode: ContinuousTranslationDisplayMode): void {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    this.generation += 1;
    if (mode === 'original') this.clear();
  }

  clear(): void {
    this.generation += 1;
    for (const [key, projection] of [...this.mounted]) {
      this.removeProjection(key, projection);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }

  private layout(projection: MountedProjection): void {
    const anchorRect = projection.surface.projectionAnchor.getBoundingClientRect();
    const rect = projection.surface.source.kind === 'viewport-region'
      ? projection.surface.viewportRect
      : projection.surface.source.element.getBoundingClientRect();
    projection.image.style.left = `${rect.left - anchorRect.left}px`;
    projection.image.style.top = `${rect.top - anchorRect.top}px`;
    projection.image.style.width = `${rect.width}px`;
    projection.image.style.height = `${rect.height}px`;
  }

  private removeProjection(key: string, projection: MountedProjection): void {
    projection.resizeObserver?.disconnect();
    projection.image.remove();
    this.urlApi.revokeObjectURL(projection.url);
    this.mounted.delete(key);
  }
}
