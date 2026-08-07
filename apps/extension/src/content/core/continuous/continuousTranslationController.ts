import {
  PageArtifactQuotaError,
  type PageArtifactRef,
} from '../../../shared/pageArtifacts';
import { isRuntimeImageTranslationFailure } from '../translation/imageTranslationExecution';
import type {
  ImageTranslationExecutionActivity,
  ImageTranslationExecutionArbiter,
} from '../translation/imageTranslationExecutionArbiter';
import type {
  ContinuousTranslationModule,
  ReaderEngineSession,
  ReaderPageIdentity,
  ReaderPageSurface,
  ReaderVisibleSpread,
} from './contracts';
import {
  computeContentFingerprint,
  contentFingerprintsMatch,
} from './contentFingerprint';
import type { ContinuousTabStatePort } from './continuousTabStatePort';
import type { PageArtifactPort } from './pageArtifactPort';
import { PageSourceResolver, type ResolvedPageSource } from './pageSourceResolver';
import type { ReaderEngineRegistry } from './readerEngineRegistry';
import { StableSpreadMonitor } from './stableSpreadMonitor';

export type ContinuousTranslationDisplayMode = 'translated' | 'original';

export type ContinuousTranslationViewState = {
  enabled: boolean;
  displayMode: ContinuousTranslationDisplayMode;
  phase: 'off' | 'starting' | 'watching' | 'paused' | 'error';
  queued: number;
  failed: number;
  canRetry: boolean;
  processingPage?: number;
  message?: string;
};

export type ContinuousTranslationBarHandlers = {
  setEnabled(enabled: boolean): void;
  setDisplayMode(mode: ContinuousTranslationDisplayMode): void;
  retryFailures(): void;
};

export interface ContinuousTranslationBarPort {
  setHandlers(handlers: ContinuousTranslationBarHandlers): void;
  mount(): void;
  update(state: ContinuousTranslationViewState): void;
  dispose(): void;
}

export type ContinuousTranslationResult = {
  identity: ReaderPageIdentity;
  fingerprint: string;
  artifact: PageArtifactRef;
};

export interface PageProjectionPort {
  sync(
    spread: ReaderVisibleSpread,
    results: readonly ContinuousTranslationResult[],
    currentFingerprints?: ReadonlyMap<string, string>,
  ): Promise<void> | void;
  setDisplayMode(mode: ContinuousTranslationDisplayMode): void;
  clear(): void;
  dispose(): void;
}

type SpreadMonitor = { start(): void; dispose(): void };

export type ContinuousTranslationDependencies = {
  registry: ReaderEngineRegistry;
  artifacts: PageArtifactPort;
  tabState: ContinuousTabStatePort;
  sourceResolver: Pick<PageSourceResolver, 'resolve'>;
  executionArbiter: ImageTranslationExecutionArbiter;
  fingerprint?: (file: File) => Promise<string>;
  fingerprintsMatch?: (left: string, right: string) => boolean;
  createMonitor?: (
    session: ReaderEngineSession,
    onStable: (spread: ReaderVisibleSpread) => void,
  ) => SpreadMonitor;
  bar: ContinuousTranslationBarPort;
  projection: PageProjectionPort;
  observeDetection?: (onChange: () => void) => () => void;
  setRetryTimer?: (callback: () => void, delayMs: number) => unknown;
  clearRetryTimer?: (timer: unknown) => void;
  isDocumentVisible?: () => boolean;
  waitBeforeCaptureRetry?: (delayMs: number) => Promise<void>;
};

type PageWork = {
  identity: ReaderPageIdentity;
  fingerprint: string;
  sourceArtifact: PageArtifactRef;
};

function pageKey(identity: ReaderPageIdentity): string {
  return `${identity.engineId}:${identity.contextKey}:${identity.pageIndex}`;
}

function sameSurface(left: ReaderPageSurface, right: ReaderPageSurface): boolean {
  if (pageKey(left.identity) !== pageKey(right.identity) || left.slot !== right.slot) return false;
  if (left.source.kind !== right.source.kind) return false;
  const sameSource = left.source.kind === 'viewport-region'
    || right.source.kind === 'viewport-region'
    || left.source.element === right.source.element;
  return sameSource
    && Math.abs(left.viewportRect.left - right.viewportRect.left) <= 1
    && Math.abs(left.viewportRect.top - right.viewportRect.top) <= 1
    && Math.abs(left.viewportRect.width - right.viewportRect.width) <= 1
    && Math.abs(left.viewportRect.height - right.viewportRect.height) <= 1;
}

function sameRequestedSpread(left: ReaderVisibleSpread, right: ReaderVisibleSpread): boolean {
  return left.pages.length > 0
    && left.pages.length === right.pages.length
    && left.pages.every((surface, index) => sameSurface(surface, right.pages[index]));
}

function defaultDetectionObserver(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || !document.documentElement) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => onChange());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', onChange);
  return () => {
    observer.disconnect();
    document.removeEventListener('visibilitychange', onChange);
  };
}

class ContinuousTranslationController implements ContinuousTranslationModule {
  private session: ReaderEngineSession | undefined;
  private monitor: SpreadMonitor | undefined;
  private activity: ImageTranslationExecutionActivity | undefined;
  private stopDetection: (() => void) | undefined;
  private detectionRoot: Element | undefined;
  private detectionAnchor: Element | undefined;
  private readerContext: { engineId: string; contextKey: string } | undefined;
  private detectionChain: Promise<void> = Promise.resolve();
  private barMounted = false;
  private retryTimer: unknown;
  private readonly queue: PageWork[] = [];
  private readonly failures: PageWork[] = [];
  private readonly results: ContinuousTranslationResult[] = [];
  private readonly knownFingerprints = new Map<string, string[]>();
  private readonly currentFingerprints = new Map<string, string>();
  private readonly pendingArtifacts = new Map<string, PageArtifactRef>();
  private inFlightWork: PageWork | undefined;
  private captureChain: Promise<void> = Promise.resolve();
  private draining = false;
  private started = false;
  private disposed = false;
  private enabled = false;
  private displayMode: ContinuousTranslationDisplayMode = 'translated';
  private phase: ContinuousTranslationViewState['phase'] = 'off';
  private message: string | undefined;
  private processingPage: number | undefined;
  private captureFailures = 0;
  private capturePausedForQuota = false;
  private projectionFailureMessage: string | undefined;
  private projectionSyncRevision = 0;
  private generation = 0;

  constructor(private readonly dependencies: ContinuousTranslationDependencies) {}

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.dependencies.bar.setHandlers({
      setEnabled: (enabled) => {
        void this.dependencies.tabState.write(enabled)
          .then(() => this.setEnabled(enabled))
          .catch((error: unknown) => this.fail(error));
      },
      setDisplayMode: (mode) => this.setDisplayMode(mode),
      retryFailures: () => this.retryFailures(),
    });
    this.stopDetection = (this.dependencies.observeDetection ?? defaultDetectionObserver)(
      () => this.scheduleDetection(),
    );
    this.scheduleDetection();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.stopDetection?.();
    this.stopDetection = undefined;
    this.stopWatching('连续翻译页面会话已结束');
    this.session?.dispose();
    this.session = undefined;
    this.detectionRoot = undefined;
    this.detectionAnchor = undefined;
    this.dependencies.bar.dispose();
    this.dependencies.projection.dispose();
    void this.dependencies.artifacts.clear();
  }

  private scheduleDetection(): void {
    this.detectionChain = this.detectionChain
      .then(() => this.detect())
      .catch((error: unknown) => this.fail(error));
  }

  private async detect(): Promise<void> {
    if (this.disposed) return;
    const match = this.dependencies.registry.detect();
    if (!match) {
      if (
        this.session
        && (
          this.detectionRoot?.isConnected === false
          || this.detectionAnchor?.isConnected === false
        )
      ) this.suspendReaderSession();
      return;
    }

    const candidate = match.adapter.createSession(match.detection);
    const nextContext = { engineId: candidate.engineId, contextKey: candidate.contextKey };
    if (
      this.session
      && this.detectionRoot === match.detection.root
      && this.detectionAnchor === (match.detection.sessionAnchor ?? match.detection.root)
      && this.readerContext?.engineId === nextContext.engineId
      && this.readerContext.contextKey === nextContext.contextKey
    ) {
      candidate.dispose();
      if (!this.isDocumentVisible()) this.dependencies.projection.clear();
      return;
    }

    const contextChanged = Boolean(
      this.readerContext
      && (
        this.readerContext.engineId !== nextContext.engineId
        || this.readerContext.contextKey !== nextContext.contextKey
      ),
    );
    this.monitor?.dispose();
    this.monitor = undefined;
    this.session?.dispose();
    this.session = undefined;
    if (contextChanged) await this.resetReaderContext();
    if (this.disposed) {
      candidate.dispose();
      return;
    }
    this.session = candidate;
    this.detectionRoot = match.detection.root;
    this.detectionAnchor = match.detection.sessionAnchor ?? match.detection.root;
    this.readerContext = nextContext;
    if (!this.barMounted) {
      this.barMounted = true;
      this.dependencies.bar.mount();
      this.updateBar();
      const enabled = await this.dependencies.tabState.read();
      await this.setEnabled(enabled);
      return;
    }
    if (this.enabled) {
      if (this.activity && !this.activity.signal.aborted) {
        this.phase = 'watching';
        this.message = undefined;
        this.startMonitor();
        void this.drain();
      } else {
        await this.startWatchingAfterProbe();
        return;
      }
    }
    this.updateBar();
  }

  private suspendReaderSession(): void {
    this.monitor?.dispose();
    this.monitor = undefined;
    this.session?.dispose();
    this.session = undefined;
    this.detectionRoot = undefined;
    this.detectionAnchor = undefined;
    this.dependencies.projection.clear();
    if (this.enabled) {
      this.phase = 'paused';
      this.message = '等待阅读器恢复';
    }
    this.updateBar();
  }

  private async resetReaderContext(): Promise<void> {
    this.generation += 1;
    this.stopWatching('阅读器页面已切换');
    this.queue.length = 0;
    this.failures.length = 0;
    this.results.length = 0;
    this.pendingArtifacts.clear();
    this.knownFingerprints.clear();
    this.currentFingerprints.clear();
    this.inFlightWork = undefined;
    this.captureFailures = 0;
    this.capturePausedForQuota = false;
    this.projectionFailureMessage = undefined;
    this.dependencies.projection.clear();
    await this.dependencies.artifacts.clear();
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled;
    this.generation += 1;
    if (!enabled) {
      this.phase = 'off';
      this.message = undefined;
      this.stopWatching('连续翻译模式已关闭');
      for (const work of [
        ...this.queue,
        ...this.failures,
        ...(this.inFlightWork ? [this.inFlightWork] : []),
      ]) {
        this.forgetFingerprint(work);
      }
      const pending = [...this.pendingArtifacts.values()];
      this.pendingArtifacts.clear();
      this.queue.length = 0;
      this.failures.length = 0;
      this.captureFailures = 0;
      this.capturePausedForQuota = false;
      this.projectionFailureMessage = undefined;
      await Promise.allSettled(pending.map((ref) => this.dependencies.artifacts.delete(ref)));
      this.dependencies.projection.clear();
      this.updateBar();
      return;
    }

    if (!this.session) {
      this.phase = 'paused';
      this.message = '等待阅读器恢复';
      this.updateBar();
      return;
    }

    await this.startWatchingAfterProbe();
  }

  private async startWatchingAfterProbe(): Promise<void> {
    if (!this.enabled || !this.session || this.disposed) return;
    const generation = this.generation;
    this.phase = 'starting';
    this.updateBar();
    const probe = await this.dependencies.artifacts.probe();
    if (this.disposed || generation !== this.generation || !this.enabled) return;
    if (!probe.available) {
      this.phase = 'error';
      this.message = probe.reason;
      this.updateBar();
      return;
    }
    this.beginWatching();
  }

  private beginWatching(): void {
    if (!this.enabled || !this.session || this.activity || this.disposed) return;
    const admission = this.dependencies.executionArbiter.begin({
      owner: 'continuous',
      origin: 'automatic',
      yieldToExplicit: true,
    });
    if (admission.status === 'deferred') {
      this.phase = 'paused';
      this.message = '等待当前图片翻译操作完成';
      this.scheduleAdmissionRetry();
      this.updateBar();
      return;
    }
    this.activity = admission.activity;
    this.activity.signal.addEventListener('abort', () => {
      if (this.activity === admission.activity) this.activity = undefined;
      if (this.enabled && !this.disposed) {
        this.phase = 'paused';
        this.message = '等待当前图片翻译操作完成';
        this.monitor?.dispose();
        this.monitor = undefined;
        this.scheduleAdmissionRetry();
        this.updateBar();
      }
    }, { once: true });
    this.phase = 'watching';
    this.message = undefined;
    this.startMonitor();
    this.updateBar();
    void this.drain();
  }

  private startMonitor(): void {
    if (!this.session || this.monitor || !this.enabled || this.disposed) return;
    this.monitor = (this.dependencies.createMonitor
      ?? ((session, onStable) => new StableSpreadMonitor(session, onStable)))(
        this.session,
        (spread) => this.enqueueStableSpread(spread),
      );
    this.monitor.start();
  }

  private stopWatching(reason: string): void {
    this.monitor?.dispose();
    this.monitor = undefined;
    this.activity?.end(reason);
    this.activity = undefined;
    if (this.retryTimer !== undefined) {
      if (this.dependencies.clearRetryTimer) {
        this.dependencies.clearRetryTimer(this.retryTimer);
      } else {
        clearTimeout(this.retryTimer as ReturnType<typeof setTimeout>);
      }
      this.retryTimer = undefined;
    }
  }

  private scheduleAdmissionRetry(): void {
    if (this.retryTimer !== undefined || this.disposed || !this.enabled) return;
    const setTimer = this.dependencies.setRetryTimer
      ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    this.retryTimer = setTimer(() => {
      this.retryTimer = undefined;
      this.beginWatching();
    }, 500);
  }

  private enqueueStableSpread(spread: ReaderVisibleSpread): void {
    if (
      !this.enabled
      || this.disposed
      || this.capturePausedForQuota
      || !this.isDocumentVisible()
    ) return;
    const generation = this.generation;
    this.captureChain = this.captureChain
      .then(() => this.captureSpread(spread, generation))
      .catch((error: unknown) => this.fail(error));
  }

  private async captureSpread(spread: ReaderVisibleSpread, generation: number): Promise<void> {
    const resolved = await this.resolveSpreadSources(spread, generation);
    if (!resolved) return;
    for (const source of resolved) {
      if (
        this.disposed
        || !this.enabled
        || generation !== this.generation
        || !this.isDocumentVisible()
        || !this.isSurfaceCurrent(source.surface)
      ) return;
      if (!await this.capturePage(source)) break;
    }
    if (this.session) await this.syncProjection(this.session.readVisibleSpread());
    void this.drain();
  }

  private async resolveSpreadSources(
    spread: ReaderVisibleSpread,
    generation: number,
  ): Promise<ResolvedPageSource[] | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const currentSpread = this.session?.readVisibleSpread();
      if (
        this.disposed
        || !this.enabled
        || generation !== this.generation
        || !this.isDocumentVisible()
        || !currentSpread
        || !sameRequestedSpread(spread, currentSpread)
      ) {
        return null;
      }
      try {
        const resolved = await this.dependencies.sourceResolver.resolve(currentSpread.pages);
        const after = this.session?.readVisibleSpread();
        if (
          !this.isDocumentVisible()
          || !after
          || !sameRequestedSpread(currentSpread, after)
        ) return null;
        this.captureFailures = 0;
        return resolved;
      } catch (error) {
        const afterFailure = this.session?.readVisibleSpread();
        if (
          !this.isDocumentVisible()
          || !afterFailure
          || !sameRequestedSpread(spread, afterFailure)
        ) return null;
        if (attempt === 2) {
          this.captureFailures += spread.pages.length;
          this.message = error instanceof Error ? error.message : String(error);
          this.updateBar();
          return null;
        }
        const delayMs = 250 * (2 ** attempt);
        if (this.dependencies.waitBeforeCaptureRetry) {
          await this.dependencies.waitBeforeCaptureRetry(delayMs);
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    return null;
  }

  private async capturePage(source: ResolvedPageSource): Promise<boolean> {
    const fingerprint = await (
      this.dependencies.fingerprint ?? computeContentFingerprint
    )(source.file);
    const key = pageKey(source.surface.identity);
    this.currentFingerprints.set(key, fingerprint);
    const known = this.knownFingerprints.get(key) ?? [];
    const matches = this.dependencies.fingerprintsMatch ?? contentFingerprintsMatch;
    if (known.some((value) => matches(value, fingerprint))) return true;
    if (!this.isDocumentVisible() || !this.isSurfaceCurrent(source.surface)) return false;

    let sourceArtifact: PageArtifactRef;
    try {
      sourceArtifact = await this.dependencies.artifacts.put({
        kind: 'source-snapshot',
        file: source.file,
      });
    } catch (error) {
      if (!(error instanceof PageArtifactQuotaError)) throw error;
      this.capturePausedForQuota = true;
      this.message = error.message;
      this.updateBar();
      return false;
    }
    if (!this.isDocumentVisible() || !this.isSurfaceCurrent(source.surface)) {
      await this.dependencies.artifacts.delete(sourceArtifact);
      return false;
    }
    const work: PageWork = {
      identity: source.surface.identity,
      fingerprint,
      sourceArtifact,
    };
    known.push(fingerprint);
    this.knownFingerprints.set(key, known);
    this.pendingArtifacts.set(sourceArtifact.id, sourceArtifact);
    this.queue.push(work);
    this.updateBar();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.activity || !this.enabled || this.phase !== 'watching') return;
    this.draining = true;
    const activity = this.activity;
    const generation = this.generation;
    try {
      while (
        this.queue.length > 0
        && this.activity === activity
        && !activity.signal.aborted
        && this.enabled
        && generation === this.generation
      ) {
        const work = this.queue.shift()!;
        this.inFlightWork = work;
        this.processingPage = work.identity.pageIndex + 1;
        this.updateBar();
        try {
          const sourceFile = await this.dependencies.artifacts.read(work.sourceArtifact);
          const task = activity.start({
            source: { kind: 'prepared-file', file: sourceFile },
            allowedKinds: ['local-pipeline'],
          });
          const result = await task.result;
          if (
            this.activity !== activity
            || activity.signal.aborted
            || generation !== this.generation
            || !this.enabled
          ) {
            if (
              this.enabled
              && generation === this.generation
              && this.pendingArtifacts.has(work.sourceArtifact.id)
            ) {
              this.queue.unshift(work);
            }
            break;
          }
          const translated = new File(
            [result.image],
            `translated-page-${work.identity.pageIndex + 1}.png`,
            { type: result.image.type || 'image/png' },
          );
          const resultArtifact = await this.storeTranslatedResult(work, translated);
          if (!resultArtifact) break;
          if (this.pendingArtifacts.has(work.sourceArtifact.id)) {
            await this.dependencies.artifacts.delete(work.sourceArtifact);
            this.pendingArtifacts.delete(work.sourceArtifact.id);
            this.resumeCaptureAfterSpaceReleased();
          }
          this.results.push({
            identity: work.identity,
            fingerprint: work.fingerprint,
            artifact: resultArtifact,
          });
          if (this.session) await this.syncProjection(this.session.readVisibleSpread());
        } catch (error) {
          if (activity.signal.aborted || this.activity !== activity) {
            if (
              this.enabled
              && generation === this.generation
              && this.pendingArtifacts.has(work.sourceArtifact.id)
            ) {
              this.queue.unshift(work);
            }
            break;
          }
          if (isRuntimeImageTranslationFailure(error)) {
            this.queue.unshift(work);
            this.phase = 'paused';
            this.message = error instanceof Error ? error.message : String(error);
            break;
          }
          this.failures.push(work);
        } finally {
          if (this.inFlightWork === work) this.inFlightWork = undefined;
          this.processingPage = undefined;
          this.updateBar();
        }
      }
    } finally {
      this.draining = false;
      if (
        this.queue.length > 0
        && this.activity
        && !this.activity.signal.aborted
        && this.enabled
        && this.phase === 'watching'
      ) {
        void this.drain();
      }
    }
  }

  private async storeTranslatedResult(
    work: PageWork,
    translated: File,
  ): Promise<PageArtifactRef | null> {
    const put = (): Promise<PageArtifactRef> => this.dependencies.artifacts.put({
      kind: 'translated-result',
      file: translated,
    });
    try {
      return await put();
    } catch (error) {
      if (!(error instanceof PageArtifactQuotaError)) {
        this.failures.push(work);
        this.phase = 'paused';
        this.message = `结果存储失败：${error instanceof Error ? error.message : String(error)}`;
        return null;
      }

      await this.dependencies.artifacts.delete(work.sourceArtifact);
      this.pendingArtifacts.delete(work.sourceArtifact.id);
      this.resumeCaptureAfterSpaceReleased();
      try {
        return await put();
      } catch (retryError) {
        this.forgetFingerprint(work);
        this.captureFailures += 1;
        this.phase = 'paused';
        this.message = `结果存储失败：${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`;
        return null;
      }
    }
  }

  private forgetFingerprint(work: PageWork): void {
    const key = pageKey(work.identity);
    const known = this.knownFingerprints.get(key);
    if (!known) return;
    const remaining = known.filter((fingerprint) => fingerprint !== work.fingerprint);
    if (remaining.length > 0) this.knownFingerprints.set(key, remaining);
    else this.knownFingerprints.delete(key);
  }

  private resumeCaptureAfterSpaceReleased(): void {
    if (!this.capturePausedForQuota) return;
    this.capturePausedForQuota = false;
    this.message = undefined;
    if (this.session) this.enqueueStableSpread(this.session.readVisibleSpread());
  }

  private retryFailures(): void {
    if (
      this.failures.length === 0
      && this.captureFailures === 0
      && !this.capturePausedForQuota
      && !this.projectionFailureMessage
      && this.phase !== 'paused'
    ) return;
    this.queue.push(...this.failures.splice(0));
    const retryCapture = this.captureFailures > 0 || this.capturePausedForQuota;
    const retryProjection = Boolean(this.projectionFailureMessage);
    this.captureFailures = 0;
    this.capturePausedForQuota = false;
    if (retryCapture) this.message = undefined;
    if (this.phase === 'paused' && this.activity) {
      this.phase = 'watching';
      this.message = undefined;
    }
    this.updateBar();
    if (retryCapture && this.session) {
      this.enqueueStableSpread(this.session.readVisibleSpread());
    }
    if (retryProjection && this.session) {
      void this.syncProjection(this.session.readVisibleSpread());
    }
    void this.drain();
  }

  private setDisplayMode(mode: ContinuousTranslationDisplayMode): void {
    this.displayMode = mode;
    this.dependencies.projection.setDisplayMode(mode);
    if (this.session) void this.syncProjection(this.session.readVisibleSpread());
    this.updateBar();
  }

  private async syncProjection(spread: ReaderVisibleSpread): Promise<void> {
    const revision = ++this.projectionSyncRevision;
    const generation = this.generation;
    if (!this.isDocumentVisible()) {
      this.dependencies.projection.clear();
      return;
    }
    try {
      await this.dependencies.projection.sync(spread, this.results, this.currentFingerprints);
      if (
        this.disposed
        || generation !== this.generation
        || revision !== this.projectionSyncRevision
      ) return;
      if (this.projectionFailureMessage) {
        if (this.message === this.projectionFailureMessage) this.message = undefined;
        this.projectionFailureMessage = undefined;
        this.updateBar();
      }
    } catch (error) {
      if (
        this.disposed
        || generation !== this.generation
        || revision !== this.projectionSyncRevision
      ) return;
      const detail = error instanceof Error ? error.message : String(error);
      this.projectionFailureMessage = `译文显示失败：${detail}`;
      this.message = this.projectionFailureMessage;
      this.updateBar();
    }
  }

  private isSurfaceCurrent(surface: ReaderPageSurface): boolean {
    return this.session?.readVisibleSpread().pages.some((current) => sameSurface(surface, current))
      ?? false;
  }

  private isDocumentVisible(): boolean {
    return (this.dependencies.isDocumentVisible
      ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible'))();
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    this.phase = 'error';
    this.message = error instanceof Error ? error.message : String(error);
    this.updateBar();
  }

  private updateBar(): void {
    this.dependencies.bar.update({
      enabled: this.enabled,
      displayMode: this.displayMode,
      phase: this.phase,
      queued: this.queue.length,
      failed: this.failures.length + this.captureFailures,
      canRetry: this.failures.length + this.captureFailures > 0
        || this.capturePausedForQuota
        || Boolean(this.projectionFailureMessage)
        || this.phase === 'paused',
      ...(this.processingPage !== undefined ? { processingPage: this.processingPage } : {}),
      ...(this.message ? { message: this.message } : {}),
    });
  }
}

export function createContinuousTranslationModule(
  dependencies: ContinuousTranslationDependencies,
): ContinuousTranslationModule {
  return new ContinuousTranslationController(dependencies);
}
