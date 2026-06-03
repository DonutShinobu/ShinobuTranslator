import type {
  ProgressJankEntry,
  ProgressJankFrameStats,
  ProgressJankLongFrameScript,
  ProgressJankReport,
  ProgressJankStageSummary,
  ProgressJankUiStats,
  ProgressJankWorkerHeartbeatMode,
} from './types';
import type { PerfTraceWorkerCall } from '../../shared/perfTrace';
import { setPerfTraceSink } from '../../shared/perfTrace';

type FrameSample = {
  startMs: number;
  endMs: number;
  deltaMs: number;
};

type StageMark = {
  stage: string;
  detail: string;
  stageText: string;
  startMs: number;
};

type LongFrameSample = {
  startMs: number;
  durationMs: number;
  blockingDurationMs?: number;
  renderStartMs?: number;
  styleAndLayoutStartMs?: number;
  firstUIEventTimestampMs?: number;
  stage?: string;
  scripts?: ProgressJankLongFrameScript[];
};

type LongTaskSample = {
  startMs: number;
  durationMs: number;
  stage?: string;
};

type WorkerHeartbeatMessage =
  | { type: 'ready'; mode: Exclude<ProgressJankWorkerHeartbeatMode, 'unavailable' | 'error'> }
  | { type: 'tick'; time: number }
  | { type: 'error'; error: string };

const slowFrameMs = 33;
const workerHeartbeatScript = `
let active = false;
let rafId = 0;
let timerId = 0;
const hasRaf = typeof self.requestAnimationFrame === "function" && typeof self.cancelAnimationFrame === "function";
const mode = hasRaf ? "worker-raf" : "worker-timer";

function post(type, payload) {
  self.postMessage(Object.assign({ type }, payload || {}));
}

function scheduleTick() {
  if (!active) return;
  if (hasRaf) {
    rafId = self.requestAnimationFrame(tick);
  } else {
    timerId = self.setTimeout(function () { tick(self.performance.now()); }, 16);
  }
}

function tick(time) {
  if (!active) return;
  post("tick", { time: typeof time === "number" ? time : self.performance.now() });
  scheduleTick();
}

self.addEventListener("message", function (event) {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "start") {
    if (active) return;
    active = true;
    post("ready", { mode });
    tick(self.performance.now());
  } else if (data.type === "stop") {
    active = false;
    if (hasRaf) {
      self.cancelAnimationFrame(rafId);
    } else {
      self.clearTimeout(timerId);
    }
  }
});
`;

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function buildFrameStats(deltas: number[]): ProgressJankFrameStats {
  return {
    samples: deltas.length,
    maxDeltaMs: roundMetric(deltas.length > 0 ? Math.max(...deltas) : 0),
    p95DeltaMs: roundMetric(percentile(deltas, 95)),
    over33Count: deltas.filter((value) => value > 33).length,
    over50Count: deltas.filter((value) => value > 50).length,
    over100Count: deltas.filter((value) => value > 100).length,
    longestSlowStreak: computeLongestSlowStreakFromDeltas(deltas),
  };
}

function computeLongestSlowStreakFromDeltas(deltas: number[]): number {
  let current = 0;
  let longest = 0;
  for (const deltaMs of deltas) {
    if (deltaMs > slowFrameMs) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function readNumericProperty(entry: PerformanceEntry, key: string): number | undefined {
  const value = (entry as PerformanceEntry & Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

function readRelativeNumericProperty(entry: PerformanceEntry, key: string, startedAt: number): number | undefined {
  const value = readNumericProperty(entry, key);
  if (value === undefined || value <= 0) {
    return undefined;
  }
  return roundMetric(Math.max(0, value - startedAt));
}

function supportedPerformanceEntry(type: string): boolean {
  const observer = globalThis.PerformanceObserver as typeof PerformanceObserver | undefined;
  return Array.isArray(observer?.supportedEntryTypes) && observer.supportedEntryTypes.includes(type);
}

function isWorkerHeartbeatMessage(value: unknown): value is WorkerHeartbeatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<WorkerHeartbeatMessage>;
  if (message.type === 'ready') {
    return message.mode === 'worker-raf' || message.mode === 'worker-timer';
  }
  if (message.type === 'tick') {
    return typeof message.time === 'number' && Number.isFinite(message.time);
  }
  return message.type === 'error' && typeof message.error === 'string';
}

function readLongFrameScripts(entry: PerformanceEntry, startedAt: number): ProgressJankLongFrameScript[] | undefined {
  const scripts = (entry as PerformanceEntry & { scripts?: unknown }).scripts;
  if (!Array.isArray(scripts) || scripts.length === 0) {
    return undefined;
  }
  const parsed = scripts
    .map((script): ProgressJankLongFrameScript | null => {
      if (!script || typeof script !== 'object') return null;
      const record = script as Record<string, unknown>;
      const durationMs = record.duration;
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null;
      const executionStart = record.executionStart;
      const sourceCharPosition = record.sourceCharPosition;
      const item: ProgressJankLongFrameScript = {
        durationMs: roundMetric(durationMs),
        invoker: readStringProperty(record, 'invoker'),
        invokerType: readStringProperty(record, 'invokerType'),
        sourceURL: readStringProperty(record, 'sourceURL'),
        sourceFunctionName: readStringProperty(record, 'sourceFunctionName'),
        windowAttribution: readStringProperty(record, 'windowAttribution'),
      };
      if (typeof executionStart === 'number' && Number.isFinite(executionStart) && executionStart > 0) {
        item.executionStartMs = roundMetric(Math.max(0, executionStart - startedAt));
      }
      if (typeof sourceCharPosition === 'number' && Number.isFinite(sourceCharPosition)) {
        item.sourceCharPosition = sourceCharPosition;
      }
      const forcedStyleAndLayoutDuration = record.forcedStyleAndLayoutDuration;
      if (typeof forcedStyleAndLayoutDuration === 'number' && Number.isFinite(forcedStyleAndLayoutDuration)) {
        item.forcedStyleAndLayoutDurationMs = roundMetric(forcedStyleAndLayoutDuration);
      }
      const pauseDuration = record.pauseDuration;
      if (typeof pauseDuration === 'number' && Number.isFinite(pauseDuration)) {
        item.pauseDurationMs = roundMetric(pauseDuration);
      }
      return item;
    })
    .filter((script): script is ProgressJankLongFrameScript => script !== null)
    .sort((a, b) => b.durationMs - a.durationMs);
  return parsed.length > 0 ? parsed.slice(0, 5) : undefined;
}

export class ProgressJankMonitor {
  private readonly entry: ProgressJankEntry;
  private readonly runId: string;
  private readonly startedAt = performance.now();
  private readonly frames: FrameSample[] = [];
  private readonly workerFrames: FrameSample[] = [];
  private readonly longFrames: LongFrameSample[] = [];
  private readonly longTasks: LongTaskSample[] = [];
  private readonly stages: StageMark[] = [];
  private readonly workerCalls: ProgressJankReport['workerCalls'] = [];
  private readonly mainThreadTasks: ProgressJankReport['mainThreadTasks'] = [];
  private readonly ui: ProgressJankUiStats = {
    renderCalls: 0,
    renderTotalMs: 0,
    renderMaxMs: 0,
    stageTextChanges: 0,
  };

  private rafId: number | null = null;
  private lastFrameAt: number | null = null;
  private active = false;
  private lastStageText = '';
  private disposeTraceSink: (() => void) | null = null;
  private longFrameObserver: PerformanceObserver | null = null;
  private longTaskObserver: PerformanceObserver | null = null;
  private workerHeartbeat: Worker | null = null;
  private workerHeartbeatMode: ProgressJankWorkerHeartbeatMode = 'unavailable';
  private workerHeartbeatError: string | undefined;
  private workerFirstTickAt: number | null = null;
  private lastWorkerTickAt: number | null = null;
  private longAnimationFrameSupported = false;
  private longTaskSupported = false;
  private finishedReport: ProgressJankReport | null = null;

  constructor(entry: ProgressJankEntry) {
    this.entry = entry;
    this.runId = `${entry}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  start(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.disposeTraceSink = setPerfTraceSink({
      recordWorkerCall: (call) => this.recordWorkerCall(call),
    });
    this.startFrameSampler();
    this.startPerformanceObservers();
    this.startWorkerHeartbeat();
  }

  stop(): void {
    this.active = false;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.drainPerformanceObservers();
    this.longFrameObserver?.disconnect();
    this.longFrameObserver = null;
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;
    if (this.workerHeartbeat) {
      try {
        this.workerHeartbeat.postMessage({ type: 'stop' });
      } catch {
        // The heartbeat is diagnostic-only; ignore shutdown races.
      }
      this.workerHeartbeat.terminate();
      this.workerHeartbeat = null;
    }
    this.disposeTraceSink?.();
    this.disposeTraceSink = null;
  }

  setStage(stage: string, detail: string, stageText: string): void {
    const startMs = Math.max(0, performance.now() - this.startedAt);
    const current = this.stages[this.stages.length - 1];
    if (!current || current.stage !== stage || current.detail !== detail) {
      this.stages.push({ stage, detail, stageText, startMs });
    }
    if (stageText !== this.lastStageText) {
      this.ui.stageTextChanges += 1;
      this.lastStageText = stageText;
    }
  }

  measureUiRender(render: () => void): void {
    const t0 = performance.now();
    try {
      render();
    } finally {
      const durationMs = performance.now() - t0;
      this.ui.renderCalls += 1;
      this.ui.renderTotalMs += durationMs;
      this.ui.renderMaxMs = Math.max(this.ui.renderMaxMs, durationMs);
    }
  }

  measureSync<T>(kind: string, task: () => T): T {
    const startedAt = performance.now();
    const startMs = roundMetric(startedAt - this.startedAt);
    try {
      return task();
    } finally {
      this.mainThreadTasks.push({
        kind,
        startMs,
        durationMs: roundMetric(performance.now() - startedAt),
        stage: this.resolveStageAt(startMs),
      });
    }
  }

  async measureAsync<T>(kind: string, task: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    const startMs = roundMetric(startedAt - this.startedAt);
    try {
      return await task();
    } finally {
      const durationMs = performance.now() - startedAt;
      this.mainThreadTasks.push({
        kind,
        startMs,
        durationMs: roundMetric(durationMs),
        stage: this.resolveStageAt(startMs),
      });
    }
  }

  finish(): ProgressJankReport {
    if (this.finishedReport) {
      return this.finishedReport;
    }
    this.stop();
    const totalMs = Math.max(0, performance.now() - this.startedAt);
    const frameDeltas = this.frames.map((frame) => frame.deltaMs);
    const workerFrameDeltas = this.workerFrames.map((frame) => frame.deltaMs);
    const workerHeartbeatAvailable = this.workerHeartbeatMode === 'worker-raf' || this.workerHeartbeatMode === 'worker-timer';
    this.finishedReport = {
      runId: this.runId,
      entry: this.entry,
      totalMs: roundMetric(totalMs),
      observerSupport: {
        longAnimationFrame: this.longAnimationFrameSupported,
        longTask: this.longTaskSupported,
        workerHeartbeat: workerHeartbeatAvailable,
        workerHeartbeatMode: this.workerHeartbeatMode,
        workerHeartbeatError: this.workerHeartbeatError,
      },
      frame: buildFrameStats(frameDeltas),
      workerHeartbeat: {
        ...buildFrameStats(workerFrameDeltas),
        available: workerHeartbeatAvailable,
        mode: this.workerHeartbeatMode,
        error: this.workerHeartbeatError,
      },
      ui: {
        renderCalls: this.ui.renderCalls,
        renderTotalMs: roundMetric(this.ui.renderTotalMs),
        renderMaxMs: roundMetric(this.ui.renderMaxMs),
        stageTextChanges: this.ui.stageTextChanges,
      },
      stages: this.buildStageSummaries(totalMs),
      workerCalls: [...this.workerCalls],
      mainThreadTasks: [...this.mainThreadTasks],
      longFrames: this.longFrames.map((item) => ({ ...item })),
      longTasks: this.longTasks.map((item) => ({ ...item })),
    };
    return this.finishedReport;
  }

  private startFrameSampler(): void {
    const tick = (time: number): void => {
      if (!this.active) {
        return;
      }
      if (this.lastFrameAt !== null) {
        const deltaMs = time - this.lastFrameAt;
        this.frames.push({
          startMs: roundMetric(this.lastFrameAt - this.startedAt),
          endMs: roundMetric(time - this.startedAt),
          deltaMs,
        });
      }
      this.lastFrameAt = time;
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private startWorkerHeartbeat(): void {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
      this.workerHeartbeatMode = 'unavailable';
      this.workerHeartbeatError = 'Worker, Blob, or URL is unavailable in this context';
      return;
    }

    let scriptUrl: string | null = null;
    try {
      const blob = new Blob([workerHeartbeatScript], { type: 'application/javascript' });
      scriptUrl = URL.createObjectURL(blob);
      const worker = new Worker(scriptUrl);
      this.workerHeartbeat = worker;
      worker.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (!isWorkerHeartbeatMessage(event.data)) return;
        if (event.data.type === 'ready') {
          this.workerHeartbeatMode = event.data.mode;
          return;
        }
        if (event.data.type === 'error') {
          this.workerHeartbeatMode = 'error';
          this.workerHeartbeatError = event.data.error;
          return;
        }
        this.recordWorkerHeartbeatTick(event.data.time);
      });
      worker.addEventListener('error', (event) => {
        this.workerHeartbeatMode = 'error';
        this.workerHeartbeatError = event.message || 'Worker heartbeat failed';
      });
      worker.postMessage({ type: 'start' });
    } catch (error) {
      this.workerHeartbeatMode = 'error';
      this.workerHeartbeatError = error instanceof Error ? error.message : String(error);
      this.workerHeartbeat?.terminate();
      this.workerHeartbeat = null;
    } finally {
      if (scriptUrl) {
        URL.revokeObjectURL(scriptUrl);
      }
    }
  }

  private recordWorkerHeartbeatTick(time: number): void {
    if (this.workerFirstTickAt === null) {
      this.workerFirstTickAt = time;
      this.lastWorkerTickAt = time;
      return;
    }
    if (this.lastWorkerTickAt === null) {
      this.lastWorkerTickAt = time;
      return;
    }
    this.workerFrames.push({
      startMs: roundMetric(this.lastWorkerTickAt - this.workerFirstTickAt),
      endMs: roundMetric(time - this.workerFirstTickAt),
      deltaMs: time - this.lastWorkerTickAt,
    });
    this.lastWorkerTickAt = time;
  }

  private startPerformanceObservers(): void {
    this.longAnimationFrameSupported = supportedPerformanceEntry('long-animation-frame');
    this.longTaskSupported = supportedPerformanceEntry('longtask');

    if (this.longAnimationFrameSupported) {
      this.longFrameObserver = new PerformanceObserver((list) => {
        this.collectLongFrameEntries(list.getEntries());
      });
      try {
        this.longFrameObserver.observe({ type: 'long-animation-frame', buffered: false });
      } catch {
        this.longAnimationFrameSupported = false;
        this.longFrameObserver = null;
      }
    }

    if (this.longTaskSupported) {
      this.longTaskObserver = new PerformanceObserver((list) => {
        this.collectLongTaskEntries(list.getEntries());
      });
      try {
        this.longTaskObserver.observe({ type: 'longtask', buffered: false });
      } catch {
        this.longTaskSupported = false;
        this.longTaskObserver = null;
      }
    }
  }

  private drainPerformanceObservers(): void {
    if (this.longFrameObserver) {
      this.collectLongFrameEntries(this.longFrameObserver.takeRecords());
    }
    if (this.longTaskObserver) {
      this.collectLongTaskEntries(this.longTaskObserver.takeRecords());
    }
  }

  private collectLongFrameEntries(entries: PerformanceEntry[]): void {
    for (const entry of entries) {
      const startMs = roundMetric(entry.startTime - this.startedAt);
      this.longFrames.push({
        startMs,
        durationMs: roundMetric(entry.duration),
        blockingDurationMs: readNumericProperty(entry, 'blockingDuration'),
        renderStartMs: readRelativeNumericProperty(entry, 'renderStart', this.startedAt),
        styleAndLayoutStartMs: readRelativeNumericProperty(entry, 'styleAndLayoutStart', this.startedAt),
        firstUIEventTimestampMs: readRelativeNumericProperty(entry, 'firstUIEventTimestamp', this.startedAt),
        stage: this.resolveStageAt(startMs),
        scripts: readLongFrameScripts(entry, this.startedAt),
      });
    }
  }

  private collectLongTaskEntries(entries: PerformanceEntry[]): void {
    for (const entry of entries) {
      const startMs = roundMetric(entry.startTime - this.startedAt);
      this.longTasks.push({
        startMs,
        durationMs: roundMetric(entry.duration),
        stage: this.resolveStageAt(startMs),
      });
    }
  }

  private recordWorkerCall(call: PerfTraceWorkerCall): void {
    if (call.startedAt < this.startedAt) {
      return;
    }
    const startMs = roundMetric(call.startedAt - this.startedAt);
    this.workerCalls.push({
      kind: call.kind,
      model: call.model,
      provider: call.provider,
      inputBytes: call.inputBytes,
      outputBytes: call.outputBytes,
      startMs,
      durationMs: roundMetric(call.durationMs),
      stage: this.resolveStageAt(startMs),
    });
  }

  private resolveStageAt(relativeMs: number): string | undefined {
    let current: StageMark | undefined;
    for (const stage of this.stages) {
      if (stage.startMs > relativeMs) {
        break;
      }
      current = stage;
    }
    return current?.stage;
  }

  private buildStageSummaries(totalMs: number): ProgressJankStageSummary[] {
    return this.stages.map((stage, index) => {
      const endMs = this.stages[index + 1]?.startMs ?? totalMs;
      const frames = this.frames.filter((frame) => frame.endMs >= stage.startMs && frame.endMs <= endMs);
      const frameDeltas = frames.map((frame) => frame.deltaMs);
      const mainThreadTasks = this.mainThreadTasks.filter((task) => task.startMs >= stage.startMs && task.startMs <= endMs);
      const workerCalls = this.workerCalls.filter((call) => call.startMs >= stage.startMs && call.startMs <= endMs);
      return {
        stage: stage.stage,
        detail: stage.detail,
        startMs: roundMetric(stage.startMs),
        durationMs: roundMetric(Math.max(0, endMs - stage.startMs)),
        maxFrameDeltaMs: roundMetric(frameDeltas.length > 0 ? Math.max(...frameDeltas) : 0),
        longFrameCount: this.longFrames.filter((frame) => frame.startMs >= stage.startMs && frame.startMs <= endMs).length,
        longTaskCount: this.longTasks.filter((task) => task.startMs >= stage.startMs && task.startMs <= endMs).length,
        mainThreadTaskCount: mainThreadTasks.length,
        maxMainThreadTaskMs: roundMetric(mainThreadTasks.length > 0 ? Math.max(...mainThreadTasks.map((task) => task.durationMs)) : 0),
        workerCallCount: workerCalls.length,
        maxWorkerCallMs: roundMetric(workerCalls.length > 0 ? Math.max(...workerCalls.map((call) => call.durationMs)) : 0),
      };
    });
  }
}
