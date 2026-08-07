import type {
  ReaderEngineSession,
  ReaderPageSurface,
  ReaderVisibleSpread,
} from './contracts';

export const STABLE_SPREAD_DELAY_MS = 400;
const geometryTolerance = 1;

type StableSpreadMonitorDependencies = {
  requestAnimationFrame?: typeof requestAnimationFrame;
  cancelAnimationFrame?: typeof cancelAnimationFrame;
};

function identityKey(surface: ReaderPageSurface): string {
  const { engineId, contextKey, pageIndex } = surface.identity;
  return `${engineId}:${contextKey}:${pageIndex}`;
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= geometryTolerance;
}

function sameSurface(left: ReaderPageSurface, right: ReaderPageSurface): boolean {
  if (
    identityKey(left) !== identityKey(right)
    || left.source.kind !== right.source.kind
    || !right.slot.isConnected
  ) {
    return false;
  }
  if (
    left.source.kind !== 'viewport-region'
    && right.source.kind !== 'viewport-region'
    && left.source.element !== right.source.element
  ) {
    return false;
  }
  if (right.source.kind === 'canvas') {
    if (
      !right.source.element.isConnected
      || right.source.element.width <= 0
      || right.source.element.height <= 0
    ) {
      return false;
    }
  }
  return closeEnough(left.viewportRect.left, right.viewportRect.left)
    && closeEnough(left.viewportRect.top, right.viewportRect.top)
    && closeEnough(left.viewportRect.width, right.viewportRect.width)
    && closeEnough(left.viewportRect.height, right.viewportRect.height);
}

function sameSpread(left: ReaderVisibleSpread, right: ReaderVisibleSpread): boolean {
  return left.pages.length > 0
    && left.pages.length === right.pages.length
    && left.pages.every((surface, index) => sameSurface(surface, right.pages[index]));
}

export class StableSpreadMonitor {
  private readonly requestFrame: typeof requestAnimationFrame;
  private readonly cancelFrame: typeof cancelAnimationFrame;
  private stopObserving: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private generation = 0;
  private started = false;
  private disposed = false;

  constructor(
    private readonly session: ReaderEngineSession,
    private readonly onStable: (spread: ReaderVisibleSpread) => void,
    dependencies: StableSpreadMonitorDependencies = {},
  ) {
    this.requestFrame = dependencies.requestAnimationFrame ?? globalThis.requestAnimationFrame;
    this.cancelFrame = dependencies.cancelAnimationFrame ?? globalThis.cancelAnimationFrame;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.stopObserving = this.session.observe(() => this.schedule());
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.stopObserving?.();
    this.stopObserving = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.frame !== undefined) this.cancelFrame(this.frame);
    this.frame = undefined;
  }

  private schedule(): void {
    if (this.disposed) return;
    this.generation += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.frame !== undefined) this.cancelFrame(this.frame);
    this.frame = undefined;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.evaluate(generation);
    }, STABLE_SPREAD_DELAY_MS);
  }

  private async evaluate(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    const before = this.session.readVisibleSpread();
    await this.nextFrame();
    await this.nextFrame();
    if (this.disposed || generation !== this.generation) return;
    const after = this.session.readVisibleSpread();
    if (sameSpread(before, after)) this.onStable(after);
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      this.frame = this.requestFrame(() => {
        this.frame = undefined;
        resolve();
      });
    });
  }
}
