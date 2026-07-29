import {
  lockProcessingConfig,
  type WebSettings,
} from '@shinobu/shared-config';
import type { PipelineProgress } from '../../../../../src/types';
import type {
  CreateLocalHistoryItemInput,
  LocalHistory,
  LocalHistoryBatch,
  LocalHistoryVersions,
} from '../history/localHistory';
import type {
  HistoryBatchClaim,
  HistoryBatchCoordinator,
} from '../history/historyCoordination';
import type { ImportedImage } from '../import/imageImporter';
import type { WebPipelineResult } from '../../runtime/webPipeline';
import type {
  ProcessingRuntime,
  ProcessingRuntimeCredential,
  ProcessingRuntimeLease,
} from './processingRuntime';

export type ProcessingBatchStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'partially-completed'
  | 'failed';

export type ProcessingTaskStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export type ProcessingBatchPersistence =
  | { status: 'healthy' }
  | {
      status: 'faulted';
      operation: string;
      error: string;
    };

export type ProcessingBatchExecution =
  | { status: 'healthy' }
  | {
      status: 'faulted';
      code: 'BATCH_EXECUTION_FAILED';
      error: string;
    };

export type ProcessingTaskResult =
  & Pick<WebPipelineResult, 'image'>
  & Partial<Omit<WebPipelineResult, 'image'>>;

export type ProcessingTaskSnapshot = {
  id: string;
  status: ProcessingTaskStatus;
  progress?: PipelineProgress;
  result?: ProcessingTaskResult;
  error?: string;
  errorCode?: string;
};

export type ProcessingBatchSnapshot = {
  id: string;
  kind: 'queue' | 'continuous-camera';
  status: ProcessingBatchStatus;
  input: 'open' | 'closed';
  execution: ProcessingBatchExecution;
  persistence: ProcessingBatchPersistence;
  currentTaskId?: string;
  tasks: readonly ProcessingTaskSnapshot[];
};

export type ProcessingBatchListener = (snapshot: ProcessingBatchSnapshot) => void;

export type ProcessingBatchCommand =
  | {
      type: 'append';
      images: readonly ImportedImage[];
    }
  | { type: 'close-input' }
  | {
      type: 'retry';
      taskId: string;
    }
  | { type: 'cancel-current' }
  | { type: 'stop' }
  | { type: 'resume' }
  | {
      type: 'remove-queued';
      taskId: string;
    }
  | {
      type: 'reorder-queued';
      taskIds: readonly string[];
    }
  | { type: 'detach' };

export type ProcessingBatchCommandResult =
  | {
      type: 'appended';
      taskIds: readonly string[];
    }
  | { type: 'input-closed' }
  | {
      type: 'task-retried';
      taskId: string;
    }
  | {
      type: 'current-cancelled';
      taskId: string;
    }
  | { type: 'batch-stopping' }
  | { type: 'batch-resumed' }
  | {
      type: 'queued-task-removed';
      taskId: string;
    }
  | { type: 'queued-tasks-reordered' }
  | { type: 'batch-detached' };

export interface ProcessingBatch {
  snapshot(): ProcessingBatchSnapshot;
  subscribe(listener: ProcessingBatchListener): () => void;
  dispatch(command: ProcessingBatchCommand): Promise<ProcessingBatchCommandResult>;
}

export type ProcessingBatchCredential = ProcessingRuntimeCredential;

export type OpenProcessingBatch = {
  kind: 'queue' | 'continuous-camera';
  inputLifetime?: 'until-idle' | 'until-closed';
  initialImages: readonly ImportedImage[];
  settings: WebSettings;
  versions: LocalHistoryVersions;
  credential: ProcessingBatchCredential;
};

export type ResumeProcessingBatch = {
  batch: Pick<LocalHistoryBatch, 'id'>;
  images: readonly ImportedImage[];
  settings: WebSettings;
  inputLifetime?: 'until-idle' | 'until-closed';
  credential: ProcessingBatchCredential;
};

export type ProcessingBatchWorkspaceDependencies = {
  history: LocalHistory;
  runtime: ProcessingRuntime;
  coordinator?: HistoryBatchCoordinator;
  readThumbnail?(image: ImportedImage): Promise<Blob | undefined>;
  createId?: () => string;
};

export interface ProcessingBatchWorkspace {
  open(input: OpenProcessingBatch): Promise<ProcessingBatch>;
  resume(input: ResumeProcessingBatch): Promise<ProcessingBatch>;
}

type ProcessingTask = ProcessingTaskSnapshot & {
  image: ImportedImage;
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeFor(error: unknown, fallback: string): string {
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return error.code;
  }
  return fallback;
}

function reportListenerError(error: unknown): void {
  const runtime = globalThis as typeof globalThis & {
    reportError?: (reason: unknown) => void;
  };
  if (runtime.reportError) {
    runtime.reportError(error);
    return;
  }
  console.error('Processing batch listener failed', error);
}

async function historyItem(
  image: ImportedImage,
  readThumbnail?: (image: ImportedImage) => Promise<Blob | undefined>,
): Promise<CreateLocalHistoryItemInput> {
  let thumbnail: Blob | undefined;
  try {
    thumbnail = await readThumbnail?.(image);
  } catch {
    // A missing thumbnail must not block the original image or result history.
  }
  return {
    id: image.id,
    file: image.file,
    thumbnail,
    width: image.width,
    height: image.height,
    workingCopy: image.workingCopy,
  };
}

class ProcessingBatchImplementation implements ProcessingBatch {
  private readonly listeners = new Set<ProcessingBatchListener>();
  private readonly tasks: ProcessingTask[];
  private status: ProcessingBatchStatus = 'running';
  private execution: ProcessingBatchExecution = { status: 'healthy' };
  private persistence: ProcessingBatchPersistence = { status: 'healthy' };
  private currentTaskId: string | undefined;
  private inputOpen: boolean;
  private historyCreated: boolean;
  private runPromise: Promise<void> | undefined;
  private commandTail = Promise.resolve();
  private historyTail = Promise.resolve();
  private activeExecution: ReturnType<ProcessingRuntimeLease['run']> | undefined;
  private runtimeLease: ProcessingRuntimeLease | undefined;
  private stopRequested = false;
  private detached = false;

  constructor(
    readonly id: string,
    private readonly input: OpenProcessingBatch,
    private readonly dependencies: ProcessingBatchWorkspaceDependencies,
    private readonly release: () => void,
    runtimeLease: ProcessingRuntimeLease,
    restored?: LocalHistoryBatch,
    restoredResults: ReadonlyMap<string, Blob> = new Map(),
  ) {
    const restoredItems = restored
      ? new Map(restored.items.map((item) => [item.id, item]))
      : undefined;
    this.tasks = input.initialImages.map((image) => {
      const restoredItem = restoredItems?.get(image.id);
      return {
        id: image.id,
        image,
        status: restoredItem?.status ?? 'queued',
        result: restoredResults.has(image.id)
          ? { image: restoredResults.get(image.id)! }
          : undefined,
        error: restoredItem?.error,
      };
    });
    this.inputOpen = (
      input.kind === 'continuous-camera'
      || input.inputLifetime === 'until-closed'
    );
    this.historyCreated = Boolean(restored) || input.initialImages.length > 0;
    this.runtimeLease = runtimeLease;
  }

  snapshot(): ProcessingBatchSnapshot {
    return {
      id: this.id,
      kind: this.input.kind,
      status: this.status,
      input: this.inputOpen ? 'open' : 'closed',
      execution: { ...this.execution },
      persistence: { ...this.persistence },
      currentTaskId: this.currentTaskId,
      tasks: this.tasks.map(({ image: _image, ...task }) => ({
        ...task,
        progress: task.progress ? { ...task.progress } : undefined,
      })),
    };
  }

  subscribe(listener: ProcessingBatchListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch (error) {
      reportListenerError(error);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    this.kick();
  }

  dispatch(command: ProcessingBatchCommand): Promise<ProcessingBatchCommandResult> {
    const operation = this.commandTail.then(() => this.applyCommand(command));
    this.commandTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  private kick(): void {
    if (this.runPromise || this.status !== 'running') return;
    const running = this.run();
    this.runPromise = running;
    void this.monitorRun(running);
  }

  private async monitorRun(running: Promise<void>): Promise<void> {
    try {
      await running;
    } catch (error) {
      await this.failExecution(error);
    } finally {
      if (this.runPromise === running) this.runPromise = undefined;
      if (
        this.status === 'running'
        && (
          this.tasks.some((task) => task.status === 'queued')
          || !this.inputOpen
        )
      ) {
        this.kick();
      }
    }
  }

  private async failExecution(error: unknown): Promise<void> {
    const interruptedTask = this.tasks.find(
      (task) => task.id === this.currentTaskId && task.status === 'running',
    );
    if (interruptedTask) {
      interruptedTask.status = 'queued';
      interruptedTask.progress = undefined;
    }
    this.status = 'paused';
    this.releaseRuntimeLease();
    this.currentTaskId = undefined;
    this.execution = {
      status: 'faulted',
      code: 'BATCH_EXECUTION_FAILED',
      error: messageFor(error),
    };
    if (this.historyCreated) {
      const nextTaskIndex = this.tasks.findIndex((task) => task.status === 'queued');
      try {
        await this.serializeHistoryOperation(() => this.dependencies.history.saveRecoveryPoint(
          this.id,
          nextTaskIndex < 0 ? this.tasks.length : nextTaskIndex,
          'paused',
        ));
      } catch (persistenceError) {
        this.persistence = {
          status: 'faulted',
          operation: 'store-execution-fault',
          error: messageFor(persistenceError),
        };
      }
    }
    this.emit();
  }

  private serializeHistoryOperation<T>(operation: () => Promise<T>): Promise<T> {
    const coordinated = (): Promise<T> => this.dependencies.coordinator
      ? this.dependencies.coordinator.withWrite(this.id, operation)
      : operation();
    const result = this.historyTail.then(coordinated);
    this.historyTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private pauseForPersistence(operation: string, error: unknown): void {
    this.persistence = {
      status: 'faulted',
      operation,
      error: messageFor(error),
    };
    this.status = 'paused';
    this.releaseRuntimeLease();
    this.emit();
  }

  private async applyCommand(
    command: ProcessingBatchCommand,
  ): Promise<ProcessingBatchCommandResult> {
    if (this.detached) throw new Error('处理批次已经离开当前工作台');

    if (command.type === 'detach') {
      if (this.status !== 'paused' || this.activeExecution) {
        throw new Error('只能离开已经暂停的处理批次');
      }
      this.detached = true;
      this.inputOpen = false;
      this.releaseRuntimeLease();
      this.emit();
      this.release();
      return { type: 'batch-detached' };
    }

    if (command.type === 'close-input') {
      if (
        !this.inputOpen
        || (this.status !== 'running' && this.status !== 'paused')
      ) {
        throw new Error('当前处理批次没有可关闭的图片输入');
      }
      this.inputOpen = false;
      if (
        this.status === 'paused'
        && this.persistence.status === 'healthy'
        && !this.tasks.some((task) => task.status === 'queued')
      ) {
        this.status = 'running';
      }
      this.emit();
      if (this.status === 'running') this.kick();
      return { type: 'input-closed' };
    }

    if (command.type === 'remove-queued') {
      if (
        (this.status !== 'running' && this.status !== 'paused')
        || this.persistence.status === 'faulted'
      ) {
        throw new Error('当前处理批次不能移除图片任务');
      }
      const taskIndex = this.tasks.findIndex((task) => task.id === command.taskId);
      const task = this.tasks[taskIndex];
      if (!task || task.status !== 'queued') {
        throw new Error('只能移除尚未开始的图片任务');
      }
      try {
        await this.serializeHistoryOperation(() =>
          this.dependencies.history.removeQueuedItem(this.id, task.id));
      } catch (error) {
        this.pauseForPersistence('remove-queued-task', error);
        throw error;
      }
      this.tasks.splice(taskIndex, 1);
      this.emit();
      return {
        type: 'queued-task-removed',
        taskId: task.id,
      };
    }

    if (command.type === 'reorder-queued') {
      if (
        (this.status !== 'running' && this.status !== 'paused')
        || this.persistence.status === 'faulted'
      ) {
        throw new Error('当前处理批次不能调整图片顺序');
      }
      try {
        await this.serializeHistoryOperation(() =>
          this.dependencies.history.reorderQueuedItems(this.id, command.taskIds));
      } catch (error) {
        this.pauseForPersistence('reorder-queued-tasks', error);
        throw error;
      }
      const tasksById = new Map(this.tasks.map((task) => [task.id, task]));
      this.tasks.splice(
        0,
        this.tasks.length,
        ...command.taskIds.map((id) => tasksById.get(id)!),
      );
      this.emit();
      return { type: 'queued-tasks-reordered' };
    }

    if (command.type === 'stop') {
      if (this.status !== 'running') {
        throw new Error('当前处理批次没有在运行');
      }
      this.stopRequested = true;
      if (this.activeExecution) {
        this.activeExecution.cancel(new DOMException('已停止整个处理批次', 'AbortError'));
      } else {
        const nextTaskIndex = this.tasks.findIndex((task) => task.status === 'queued');
        try {
          if (this.historyCreated) {
            await this.serializeHistoryOperation(() => this.dependencies.history.saveRecoveryPoint(
              this.id,
              nextTaskIndex < 0 ? this.tasks.length : nextTaskIndex,
              'paused',
            ));
          }
          this.status = 'paused';
          this.releaseRuntimeLease();
          this.emit();
        } catch (error) {
          this.pauseForPersistence('stop-batch', error);
          throw error;
        }
      }
      return { type: 'batch-stopping' };
    }

    if (command.type === 'resume') {
      if (
        this.status !== 'paused'
        || this.persistence.status === 'faulted'
        || this.activeExecution
      ) {
        throw new Error('当前处理批次不能继续运行');
      }
      const nextTaskIndex = this.tasks.findIndex((task) => task.status === 'queued');
      try {
        await this.acquireRuntimeLease(0);
      } catch (error) {
        await this.failExecution(error);
        throw error;
      }
      try {
        if (this.historyCreated) {
          await this.serializeHistoryOperation(() => this.dependencies.history.saveRecoveryPoint(
            this.id,
            nextTaskIndex < 0 ? this.tasks.length : nextTaskIndex,
            'running',
          ));
        }
      } catch (error) {
        this.pauseForPersistence('resume-batch', error);
        throw error;
      }
      this.stopRequested = false;
      this.execution = { status: 'healthy' };
      this.status = 'running';
      this.emit();
      this.kick();
      return { type: 'batch-resumed' };
    }

    if (command.type === 'cancel-current') {
      if (!this.activeExecution || !this.currentTaskId) {
        throw new Error('当前没有正在执行的图片任务');
      }
      const taskId = this.currentTaskId;
      this.activeExecution.cancel(new DOMException('已取消当前图片', 'AbortError'));
      return {
        type: 'current-cancelled',
        taskId,
      };
    }

    if (command.type === 'retry') {
      if (
        (this.status !== 'running' && this.status !== 'paused')
        || this.persistence.status === 'faulted'
      ) {
        throw new Error('当前处理批次不能重试图片任务');
      }
      const taskIndex = this.tasks.findIndex((task) => task.id === command.taskId);
      const task = this.tasks[taskIndex];
      if (!task || (task.status !== 'failed' && task.status !== 'cancelled')) {
        throw new Error('只能重试失败或已取消的图片任务');
      }
      if (this.status === 'paused') {
        try {
          await this.acquireRuntimeLease(0);
        } catch (error) {
          await this.failExecution(error);
          throw error;
        }
      }
      try {
        await this.serializeHistoryOperation(async () => {
          await this.dependencies.history.updateItem(this.id, task.id, {
            status: 'queued',
          });
          await this.dependencies.history.saveRecoveryPoint(
            this.id,
            taskIndex,
            'running',
          );
        });
      } catch (error) {
        this.pauseForPersistence('retry-task', error);
        throw error;
      }
      task.status = 'queued';
      task.progress = undefined;
      task.result = undefined;
      task.error = undefined;
      task.errorCode = undefined;
      this.execution = { status: 'healthy' };
      this.status = 'running';
      this.emit();
      this.kick();
      return {
        type: 'task-retried',
        taskId: task.id,
      };
    }

    if (this.status !== 'running') {
      throw new Error('当前处理批次不接受此操作');
    }

    if (
      !this.inputOpen
      && (
        this.input.kind === 'continuous-camera'
        || this.input.inputLifetime === 'until-closed'
      )
    ) {
      throw new Error('处理批次已经停止接收图片');
    }
    if (command.images.length === 0) {
      return { type: 'appended', taskIds: [] };
    }
    const existingIds = new Set(this.tasks.map((task) => task.id));
    const appendedIds = new Set<string>();
    for (const image of command.images) {
      if (existingIds.has(image.id) || appendedIds.has(image.id)) {
        throw new Error(`处理批次包含重复图片任务 ID: ${image.id}`);
      }
      appendedIds.add(image.id);
    }
    try {
      await this.acquireRuntimeLease(0);
      await this.runtimeLease!.admit(
        command.images.reduce((total, image) => total + image.file.size, 0),
      );
    } catch (error) {
      await this.failExecution(error);
      throw error;
    }
    try {
      const items = await Promise.all(
        command.images.map((image) =>
          historyItem(image, this.dependencies.readThumbnail)),
      );
      if (this.historyCreated) {
        await this.serializeHistoryOperation(() => this.dependencies.history.appendItems(
          this.id,
          items,
        ));
      } else {
        await this.serializeHistoryOperation(() => this.dependencies.history.createBatch({
          id: this.id,
          settings: structuredClone(this.input.settings),
          versions: structuredClone(this.input.versions),
          items,
        }));
        this.historyCreated = true;
      }
    } catch (error) {
      this.pauseForPersistence('append-images', error);
      throw error;
    }
    this.tasks.push(...command.images.map((image) => ({
      id: image.id,
      image,
      status: 'queued' as const,
    })));
    this.emit();
    this.kick();
    return {
      type: 'appended',
      taskIds: command.images.map((image) => image.id),
    };
  }

  private async run(): Promise<void> {
    await this.acquireRuntimeLease(0);
    const runtimeLease = this.runtimeLease!;

    while (this.status === 'running') {
      const taskIndex = this.tasks.findIndex((task) => task.status === 'queued');
      if (taskIndex < 0) {
        if (this.inputOpen) return;
        if (!this.historyCreated) {
          this.status = 'completed';
          this.releaseRuntimeLease();
          this.emit();
          this.release();
          return;
        }
        const completedCount = this.tasks.filter((task) => task.status === 'done').length;
        const finalStatus: Extract<
          ProcessingBatchStatus,
          'completed' | 'partially-completed' | 'failed'
        > = completedCount === this.tasks.length
          ? 'completed'
          : completedCount > 0
            ? 'partially-completed'
            : 'failed';
        try {
          await this.serializeHistoryOperation(() =>
            this.dependencies.history.finishBatch(this.id, finalStatus));
          this.status = finalStatus;
          this.releaseRuntimeLease();
          this.emit();
          this.release();
        } catch (error) {
          this.pauseForPersistence('finish-batch', error);
        }
        return;
      }
      const task = this.tasks[taskIndex];
      this.currentTaskId = task.id;
      try {
        await this.serializeHistoryOperation(() => this.dependencies.history.updateItem(this.id, task.id, {
          status: 'running',
        }));
      } catch (error) {
        this.currentTaskId = undefined;
        this.pauseForPersistence('start-task', error);
        return;
      }
      if (this.stopRequested || this.status !== 'running') {
        this.currentTaskId = undefined;
        return;
      }

      const execution = runtimeLease.run({
        file: task.image.file,
        workingCopy: {
          width: task.image.workingCopy.width,
          height: task.image.workingCopy.height,
        },
      });
      this.activeExecution = execution;
      task.status = 'running';
      task.progress = { stage: 'queued', detail: '准备 Worker 任务' };
      this.emit();
      let stopProgress = (): void => undefined;
      let progressAttached = false;
      let result: WebPipelineResult;
      try {
        try {
          stopProgress = execution.progress((progress) => {
            task.progress = progress;
            this.emit();
          });
          progressAttached = true;
          result = await execution.result;
        } catch (error) {
          if (!progressAttached) {
            execution.cancel(new DOMException('任务进度订阅失败', 'AbortError'));
            await execution.result.catch(() => undefined);
            throw error;
          }
          const cancelled = execution.signal.aborted;
          const stopping = cancelled && this.stopRequested;
          task.status = cancelled ? 'cancelled' : 'failed';
          task.error = messageFor(error);
          task.errorCode = codeFor(
            error,
            execution.signal.aborted ? 'TASK_CANCELLED' : 'PIPELINE_STAGE_FAILED',
          );
          try {
            await this.serializeHistoryOperation(async () => {
              await this.dependencies.history.updateItem(this.id, task.id, {
                status: task.status,
                error: task.error,
              });
              await this.dependencies.history.saveRecoveryPoint(
                this.id,
                taskIndex + 1,
                cancelled && !stopping ? 'running' : 'paused',
              );
            });
          } catch (persistenceError) {
            this.currentTaskId = undefined;
            this.pauseForPersistence('store-task-failure', persistenceError);
            return;
          }
          this.currentTaskId = undefined;
          if (!cancelled || stopping) {
            this.status = 'paused';
            this.releaseRuntimeLease();
          }
          this.emit();
          if (cancelled && !stopping) continue;
          return;
        }
      } finally {
        if (this.activeExecution === execution) this.activeExecution = undefined;
        stopProgress();
      }

      task.status = 'done';
      task.result = result;
      task.progress = { stage: 'done', detail: '处理完成' };
      this.emit();
      try {
        await this.serializeHistoryOperation(() => this.dependencies.history.updateItem(this.id, task.id, {
          status: 'done',
          result: result.image,
          summary: result.record,
        }));
      } catch (error) {
        this.currentTaskId = undefined;
        this.pauseForPersistence('store-task-result', error);
        return;
      }

      this.currentTaskId = undefined;
      try {
        await this.serializeHistoryOperation(() => this.dependencies.history.saveRecoveryPoint(
          this.id,
          taskIndex + 1,
          'running',
        ));
      } catch (error) {
        this.pauseForPersistence('save-recovery-point', error);
        return;
      }
      this.emit();
    }
  }

  private async acquireRuntimeLease(pendingOriginalBytes: number): Promise<void> {
    if (this.runtimeLease) return;
    this.runtimeLease = await this.dependencies.runtime.prepare({
      settings: this.input.settings,
      credential: this.input.credential,
      pendingOriginalBytes,
    });
  }

  private releaseRuntimeLease(): void {
    this.runtimeLease?.release();
    this.runtimeLease = undefined;
  }
}

class ProcessingBatchWorkspaceImplementation implements ProcessingBatchWorkspace {
  private active = false;
  private readonly createId: () => string;

  constructor(private readonly dependencies: ProcessingBatchWorkspaceDependencies) {
    this.createId = dependencies.createId ?? (() => crypto.randomUUID());
  }

  async open(input: OpenProcessingBatch): Promise<ProcessingBatch> {
    if (this.active) throw new Error('当前工作台已有活动处理批次');
    if (input.kind === 'queue' && input.initialImages.length === 0) {
      throw new Error('普通处理批次至少需要一张图片');
    }
    this.active = true;
    const id = this.createId();
    let runtimeLease: ProcessingRuntimeLease | undefined;
    let historyClaim: HistoryBatchClaim | undefined;
    try {
      historyClaim = await this.acquireHistoryClaim(id);
      runtimeLease = await this.dependencies.runtime.prepare({
        settings: input.settings,
        credential: input.credential,
        pendingOriginalBytes: input.initialImages.reduce(
          (total, image) => total + image.file.size,
          0,
        ),
      });
      if (input.initialImages.length > 0) {
        const items = await Promise.all(
          input.initialImages.map((image) =>
            historyItem(image, this.dependencies.readThumbnail)),
        );
        await this.withHistoryWrite(id, () => this.dependencies.history.createBatch({
          id,
          settings: structuredClone(input.settings),
          versions: structuredClone(input.versions),
          items,
        }));
      }
      const batch = new ProcessingBatchImplementation(
        id,
        {
          ...input,
          initialImages: [...input.initialImages],
          settings: structuredClone(input.settings),
          versions: structuredClone(input.versions),
          credential: { ...input.credential },
        },
        this.dependencies,
        () => {
          this.active = false;
          historyClaim?.release();
        },
        runtimeLease,
      );
      batch.start();
      return batch;
    } catch (error) {
      runtimeLease?.release();
      historyClaim?.release();
      this.active = false;
      throw error;
    }
  }

  async resume(input: ResumeProcessingBatch): Promise<ProcessingBatch> {
    if (this.active) throw new Error('当前工作台已有活动处理批次');
    this.active = true;
    let runtimeLease: ProcessingRuntimeLease | undefined;
    let historyClaim: HistoryBatchClaim | undefined;
    try {
      historyClaim = await this.acquireHistoryClaim(input.batch.id);
      const canonical = await this.withHistoryRead(
        input.batch.id,
        () => this.dependencies.history.get(input.batch.id),
      );
      if (!canonical) throw new Error(`找不到本地历史批次: ${input.batch.id}`);
      if (
        JSON.stringify(lockProcessingConfig(input.settings))
        !== JSON.stringify(canonical.lockedConfig)
      ) {
        throw new Error('恢复处理批次的锁定处理配置不一致');
      }
      runtimeLease = await this.dependencies.runtime.prepare({
        settings: input.settings,
        credential: input.credential,
        pendingOriginalBytes: 0,
      });
      if (!canonical.items.some(
        (item) => item.status === 'queued' || item.status === 'running',
      )) {
        throw new Error('处理批次没有可恢复的图片任务');
      }
      const imagesById = new Map(input.images.map((image) => [image.id, image]));
      if (
        imagesById.size !== canonical.items.length
        || canonical.items.some((item) => !imagesById.has(item.id))
      ) {
        throw new Error('恢复处理批次的图片与本地历史不一致');
      }
      const restoredResults = new Map<string, Blob>();
      for (const item of canonical.items) {
        if (item.status !== 'done') continue;
        if (!item.result) throw new Error(`恢复批次已完成图片缺少结果: ${item.id}`);
        const result = await this.withHistoryRead(
          input.batch.id,
          () => this.dependencies.history.readAsset(item.result!),
        );
        if (!result) throw new Error(`恢复批次结果缺失或损坏: ${item.result.fileName}`);
        restoredResults.set(item.id, result);
      }
      const restored = await this.withHistoryWrite(
        input.batch.id,
        () => this.dependencies.history.resumeBatch(input.batch.id),
      );
      const images = [...restored.items]
        .sort((left, right) => left.order - right.order)
        .map((item) => imagesById.get(item.id)!);
      const batch = new ProcessingBatchImplementation(
        restored.id,
        {
          kind: 'queue',
          inputLifetime: input.inputLifetime,
          initialImages: images,
          settings: structuredClone(input.settings),
          versions: structuredClone(restored.versions),
          credential: { ...input.credential },
        },
        this.dependencies,
        () => {
          this.active = false;
          historyClaim?.release();
        },
        runtimeLease,
        restored,
        restoredResults,
      );
      batch.start();
      return batch;
    } catch (error) {
      runtimeLease?.release();
      historyClaim?.release();
      this.active = false;
      throw error;
    }
  }

  private async acquireHistoryClaim(batchId: string): Promise<HistoryBatchClaim | undefined> {
    if (!this.dependencies.coordinator) return undefined;
    const acquired = await this.dependencies.coordinator.acquire(batchId);
    if (acquired.status === 'acquired') return acquired.claim;
    const error = new Error(
      acquired.status === 'occupied'
        ? '此处理批次正在另一个 Web 工作台实例中使用'
        : '当前浏览器无法协调多个 Web 工作台实例',
    ) as Error & { code: string };
    error.code = acquired.status === 'occupied'
      ? 'BATCH_OCCUPIED'
      : 'COORDINATION_UNAVAILABLE';
    throw error;
  }

  private withHistoryRead<T>(batchId: string, operation: () => Promise<T>): Promise<T> {
    return this.dependencies.coordinator
      ? this.dependencies.coordinator.withRead(batchId, operation)
      : operation();
  }

  private withHistoryWrite<T>(batchId: string, operation: () => Promise<T>): Promise<T> {
    return this.dependencies.coordinator
      ? this.dependencies.coordinator.withWrite(batchId, operation)
      : operation();
  }
}

export function createProcessingBatchWorkspace(
  dependencies: ProcessingBatchWorkspaceDependencies,
): ProcessingBatchWorkspace {
  return new ProcessingBatchWorkspaceImplementation(dependencies);
}
