import type { ProgressJankEntry, ProgressJankReport, ProgressJankStageSummary, ProgressJankUiStats } from './types';
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
  stage?: string;
};

type LongTaskSample = {
  startMs: number;
  durationMs: number;
  stage?: string;
};

const slowFrameMs = 33;

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

function readNumericProperty(entry: PerformanceEntry, key: string): number | undefined {
  const value = (entry as PerformanceEntry & Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function supportedPerformanceEntry(type: string): boolean {
  const observer = globalThis.PerformanceObserver as typeof PerformanceObserver | undefined;
  return Array.isArray(observer?.supportedEntryTypes) && observer.supportedEntryTypes.includes(type);
}

export class ProgressJankMonitor {
  private readonly entry: ProgressJankEntry;
  private readonly runId: string;
  private readonly startedAt = performance.now();
  private readonly frames: FrameSample[] = [];
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
  }

  stop(): void {
    this.active = false;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.longFrameObserver?.disconnect();
    this.longFrameObserver = null;
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;
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
    try {
      return task();
    } finally {
      this.mainThreadTasks.push({
        kind,
        startMs: roundMetric(startedAt - this.startedAt),
        durationMs: roundMetric(performance.now() - startedAt),
      });
    }
  }

  async measureAsync<T>(kind: string, task: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await task();
    } finally {
      const durationMs = performance.now() - startedAt;
      this.mainThreadTasks.push({
        kind,
        startMs: roundMetric(startedAt - this.startedAt),
        durationMs: roundMetric(durationMs),
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
    this.finishedReport = {
      runId: this.runId,
      entry: this.entry,
      totalMs: roundMetric(totalMs),
      frame: {
        samples: frameDeltas.length,
        maxDeltaMs: roundMetric(frameDeltas.length > 0 ? Math.max(...frameDeltas) : 0),
        p95DeltaMs: roundMetric(percentile(frameDeltas, 95)),
        over33Count: frameDeltas.filter((value) => value > 33).length,
        over50Count: frameDeltas.filter((value) => value > 50).length,
        over100Count: frameDeltas.filter((value) => value > 100).length,
        longestSlowStreak: this.computeLongestSlowStreak(),
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

  private startPerformanceObservers(): void {
    if (supportedPerformanceEntry('long-animation-frame')) {
      this.longFrameObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const startMs = roundMetric(entry.startTime - this.startedAt);
          this.longFrames.push({
            startMs,
            durationMs: roundMetric(entry.duration),
            blockingDurationMs: readNumericProperty(entry, 'blockingDuration'),
            stage: this.resolveStageAt(startMs),
          });
        }
      });
      try {
        this.longFrameObserver.observe({ type: 'long-animation-frame', buffered: false });
      } catch {
        this.longFrameObserver = null;
      }
    }

    if (supportedPerformanceEntry('longtask')) {
      this.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const startMs = roundMetric(entry.startTime - this.startedAt);
          this.longTasks.push({
            startMs,
            durationMs: roundMetric(entry.duration),
            stage: this.resolveStageAt(startMs),
          });
        }
      });
      try {
        this.longTaskObserver.observe({ type: 'longtask', buffered: false });
      } catch {
        this.longTaskObserver = null;
      }
    }
  }

  private recordWorkerCall(call: PerfTraceWorkerCall): void {
    if (call.startedAt < this.startedAt) {
      return;
    }
    this.workerCalls.push({
      kind: call.kind,
      model: call.model,
      provider: call.provider,
      inputBytes: call.inputBytes,
      outputBytes: call.outputBytes,
      startMs: roundMetric(call.startedAt - this.startedAt),
      durationMs: roundMetric(call.durationMs),
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

  private computeLongestSlowStreak(): number {
    let current = 0;
    let longest = 0;
    for (const frame of this.frames) {
      if (frame.deltaMs > slowFrameMs) {
        current += 1;
        longest = Math.max(longest, current);
      } else {
        current = 0;
      }
    }
    return longest;
  }

  private buildStageSummaries(totalMs: number): ProgressJankStageSummary[] {
    return this.stages.map((stage, index) => {
      const endMs = this.stages[index + 1]?.startMs ?? totalMs;
      const frames = this.frames.filter((frame) => frame.endMs >= stage.startMs && frame.endMs <= endMs);
      const frameDeltas = frames.map((frame) => frame.deltaMs);
      return {
        stage: stage.stage,
        detail: stage.detail,
        startMs: roundMetric(stage.startMs),
        durationMs: roundMetric(Math.max(0, endMs - stage.startMs)),
        maxFrameDeltaMs: roundMetric(frameDeltas.length > 0 ? Math.max(...frameDeltas) : 0),
        longFrameCount: this.longFrames.filter((frame) => frame.startMs >= stage.startMs && frame.startMs <= endMs).length,
        longTaskCount: this.longTasks.filter((task) => task.startMs >= stage.startMs && task.startMs <= endMs).length,
      };
    });
  }
}
