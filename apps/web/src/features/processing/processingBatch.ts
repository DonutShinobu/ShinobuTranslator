import {
  normalizeProviderTargetBinding,
  type TranslationProviderId,
  type WebSettings,
} from '@shinobu/shared-config';
import type { PipelineProgress } from '../../../../../src/types';
import type {
  CreateLocalHistoryItemInput,
  LocalHistory,
  LocalHistoryBatch,
  LocalHistoryVersions,
} from '../history/localHistory';
import type { ImportedImage } from '../import/imageImporter';
import {
  type WebPipelineResult,
  type WebTranslatorCore,
} from '../../runtime/webPipeline';
import { toWebPipelineConfig } from '../../runtime/webPipelineConfig';

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

export type ProcessingBatchCredential = {
  providerId: TranslationProviderId;
  target: string;
  value: string;
};

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
  inputLifetime?: 'until-idle' | 'until-closed';
  credential: ProcessingBatchCredential;
};

export type ProcessingBatchStorage = {
  admit(pendingOriginalBytes: number): Promise<void>;
};

export type ProcessingBatchWorkspaceDependencies = {
  history: LocalHistory;
  getCore(): WebTranslatorCore;
  storage: ProcessingBatchStorage;
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

function validateCredential(
  settings: WebSettings,
  credential: ProcessingBatchCredential,
): void {
  if (settings.processMode !== 'translate') return;
  if (!credential.value.trim()) {
    throw new Error('处理批次翻译凭据不能为空');
  }
  const profile = settings.providerProfiles[settings.translationProviderId];
  if (
    credential.providerId !== settings.translationProviderId
    || normalizeProviderTargetBinding(credential.target)
      !== normalizeProviderTargetBinding(profile.baseUrl)
  ) {
    throw new Error('处理批次凭据与锁定的翻译提供商目标不匹配');
  }
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
  private activeExecution: ReturnType<WebTranslatorCore['run']> | undefined;
  private stopRequested = false;
  private detached = false;

  constructor(
    readonly id: string,
    private readonly input: OpenProcessingBatch,
    private readonly dependencies: ProcessingBatchWorkspaceDependencies,
    private readonly release: () => void,
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
    const result = this.historyTail.then(operation);
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
    await this.dependencies.storage.admit(
      command.images.reduce((total, image) => total + image.file.size, 0),
    );
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
    const core = this.dependencies.getCore();
    const config = toWebPipelineConfig(
      structuredClone(this.input.settings),
      this.input.credential.value,
    );

    while (this.status === 'running') {
      const taskIndex = this.tasks.findIndex((task) => task.status === 'queued');
      if (taskIndex < 0) {
        if (this.inputOpen) return;
        if (!this.historyCreated) {
          this.status = 'completed';
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

      const execution = core.run({
        input: {
          file: task.image.file,
          workingCopy: {
            width: task.image.workingCopy.width,
            height: task.image.workingCopy.height,
          },
        },
        config,
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
          if (!cancelled || stopping) this.status = 'paused';
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
    validateCredential(input.settings, input.credential);
    this.active = true;
    const id = this.createId();
    try {
      await this.dependencies.storage.admit(
        input.initialImages.reduce((total, image) => total + image.file.size, 0),
      );
      if (input.initialImages.length > 0) {
        const items = await Promise.all(
          input.initialImages.map((image) =>
            historyItem(image, this.dependencies.readThumbnail)),
        );
        await this.dependencies.history.createBatch({
          id,
          settings: structuredClone(input.settings),
          versions: structuredClone(input.versions),
          items,
        });
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
        },
      );
      batch.start();
      return batch;
    } catch (error) {
      this.active = false;
      throw error;
    }
  }

  async resume(input: ResumeProcessingBatch): Promise<ProcessingBatch> {
    if (this.active) throw new Error('当前工作台已有活动处理批次');
    this.active = true;
    try {
      const canonical = await this.dependencies.history.get(input.batch.id);
      if (!canonical) throw new Error(`找不到本地历史批次: ${input.batch.id}`);
      validateCredential(canonical.settings, input.credential);
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
        const result = await this.dependencies.history.readAsset(item.result);
        if (!result) throw new Error(`恢复批次结果缺失或损坏: ${item.result.fileName}`);
        restoredResults.set(item.id, result);
      }
      const restored = await this.dependencies.history.resumeBatch(input.batch.id);
      const images = [...restored.items]
        .sort((left, right) => left.order - right.order)
        .map((item) => imagesById.get(item.id)!);
      const batch = new ProcessingBatchImplementation(
        restored.id,
        {
          kind: 'queue',
          inputLifetime: input.inputLifetime,
          initialImages: images,
          settings: structuredClone(restored.settings),
          versions: structuredClone(restored.versions),
          credential: { ...input.credential },
        },
        this.dependencies,
        () => {
          this.active = false;
        },
        restored,
        restoredResults,
      );
      batch.start();
      return batch;
    } catch (error) {
      this.active = false;
      throw error;
    }
  }
}

export function createProcessingBatchWorkspace(
  dependencies: ProcessingBatchWorkspaceDependencies,
): ProcessingBatchWorkspace {
  return new ProcessingBatchWorkspaceImplementation(dependencies);
}
