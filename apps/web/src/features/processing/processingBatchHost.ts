import type { PipelineProgress } from '@shinobu/image-pipeline';
import type {
  ProcessingBatch,
  ProcessingBatchSnapshot,
  ProcessingTaskSnapshot,
} from './processingBatch';

export type QueueJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type QueueJobState = {
  status: QueueJobStatus;
  progress?: PipelineProgress;
  resultUrl?: string;
  resultBlob?: Blob;
  error?: string;
  errorCode?: string;
};

type ProcessingBatchHostOptions = {
  batch: ProcessingBatch;
  projectQueue: boolean;
  historyStorageError: string;
  getJobs(): Readonly<Record<string, QueueJobState>>;
  replaceJobs(jobs: Record<string, QueueJobState>): void;
  setRunning(running: boolean): void;
  hasActiveImport(): boolean;
  setNotice(message: string): void;
  onTerminal(snapshot: ProcessingBatchSnapshot): void;
};

function projectTask(
  task: ProcessingTaskSnapshot,
  previous: QueueJobState | undefined,
): QueueJobState {
  let resultUrl = previous?.resultUrl;
  if (task.result && previous?.resultBlob !== task.result.image) {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(task.result.image);
  }
  return {
    status: task.status,
    progress: task.progress,
    resultUrl,
    resultBlob: task.result?.image ?? previous?.resultBlob,
    error: task.error,
    errorCode: task.errorCode,
  };
}

function isTerminal(snapshot: ProcessingBatchSnapshot): boolean {
  return (
    snapshot.status === 'completed'
    || snapshot.status === 'partially-completed'
    || snapshot.status === 'failed'
  );
}

export function bindProcessingBatchHost(options: ProcessingBatchHostOptions): () => void {
  const {
    batch,
    projectQueue,
    historyStorageError,
    getJobs,
    replaceJobs,
    setRunning,
    hasActiveImport,
    setNotice,
    onTerminal,
  } = options;

  return batch.subscribe((snapshot) => {
    setRunning(snapshot.status === 'running');
    if (projectQueue) {
      const current = getJobs();
      const next = { ...current };
      for (const task of snapshot.tasks) {
        next[task.id] = projectTask(task, next[task.id]);
      }
      replaceJobs(next);
    }

    if (snapshot.persistence.status === 'faulted') {
      setNotice(`${historyStorageError}: ${snapshot.persistence.error}`);
    } else if (snapshot.execution.status === 'faulted') {
      setNotice(snapshot.execution.error);
    }

    if (
      projectQueue
      && snapshot.status === 'running'
      && snapshot.input === 'open'
      && !snapshot.tasks.some(
        (task) => task.status === 'queued' || task.status === 'running',
      )
      && !hasActiveImport()
    ) {
      void batch.dispatch({ type: 'close-input' }).catch((error) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
    }

    if (isTerminal(snapshot)) onTerminal(snapshot);
  });
}
