import type { ExtensionBrowserApi, ExtensionPort } from '../../shared/extensionRuntime';
import {
  ImagePipelineCancelledError,
  type PipelineCancellationReason,
} from '@shinobu/image-pipeline';
import {
  LOCAL_PIPELINE_BACKGROUND_LEASE_PORT,
  LOCAL_PIPELINE_CLIENT_PORT,
  LOCAL_PIPELINE_CHUNK_SIZE,
  LOCAL_PIPELINE_HOST_PORT,
  isLocalPipelineClientMessage,
  isLocalPipelineErrorCode,
  isLocalPipelineHostMessage,
  serializePipelineError,
  type LocalPipelineClientMessage,
  type LocalPipelineErrorCode,
  type LocalPipelineHostMessage,
} from '@shinobu/image-pipeline/protocol';
import {
  ChromiumPipelineHostLifecycle,
  createPipelineHostError,
  type PipelineHostLifecycle,
} from './pipelineHostLifecycle';

const PIPELINE_HOST_CONNECT_TIMEOUT_MS = 10_000;

type ClientConnection = {
  port: ExtensionPort;
  jobs: Set<string>;
  closed: boolean;
};

type HostWaiter = {
  resolve: (port: ExtensionPort) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type BufferedJob = {
  diagnosticRunId?: string;
  state: 'prepared' | 'receiving' | 'queued' | 'active';
  start?: Extract<LocalPipelineClientMessage, { type: 'start' }>;
  chunks: Map<number, Extract<LocalPipelineClientMessage, { type: 'input-chunk' }>>;
  receivedChars: number;
  receiveTimer: ReturnType<typeof setTimeout>;
  terminalError?: unknown;
};

const INPUT_RECEIVE_TIMEOUT_MS = 60_000;

function codedError(code: LocalPipelineErrorCode, message: string, cause?: unknown): Error & { code: LocalPipelineErrorCode } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: LocalPipelineErrorCode };
  error.name = 'PipelineHostError';
  error.code = code;
  return error;
}

function getJobId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const jobId = (value as { jobId?: unknown }).jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
}

function safelyPost(port: ExtensionPort, message: unknown): boolean {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

export class PipelineHostBroker {
  private readonly backgroundLeases = new Set<ExtensionPort>();
  private readonly clients = new Set<ClientConnection>();
  private readonly owners = new Map<string, ClientConnection>();
  private readonly jobs = new Map<string, BufferedJob>();
  private hostPort: ExtensionPort | null = null;
  private hostReady = false;
  private hostWaiters = new Set<HostWaiter>();
  private creationPromise: Promise<ExtensionPort> | null = null;
  private expectedHostClose = false;
  private closingPromise: Promise<void> | null = null;
  private readonly admissionQueue: string[] = [];
  private activeJobId: string | null = null;
  private pendingIdleClose = false;

  constructor(
    private readonly api: ExtensionBrowserApi,
    private readonly lifecycle: PipelineHostLifecycle = new ChromiumPipelineHostLifecycle(api),
  ) {}

  register(): void {
    this.api.runtime?.onConnect?.addListener((port) => this.handlePort(port));
  }

  handlePort(port: ExtensionPort): void {
    if (port.name === LOCAL_PIPELINE_BACKGROUND_LEASE_PORT) {
      this.attachBackgroundLease(port);
      return;
    }
    if (port.name === LOCAL_PIPELINE_HOST_PORT) {
      this.attachHost(port);
      return;
    }
    if (port.name === LOCAL_PIPELINE_CLIENT_PORT) {
      this.attachClient(port);
      return;
    }
    port.disconnect();
  }

  private attachBackgroundLease(port: ExtensionPort): void {
    this.backgroundLeases.add(port);
    port.onDisconnect.addListener(() => {
      this.backgroundLeases.delete(port);
    });
  }

  private releaseBackgroundLeases(): void {
    for (const port of [...this.backgroundLeases]) {
      this.backgroundLeases.delete(port);
      port.disconnect();
    }
  }

  private attachClient(port: ExtensionPort): void {
    const connection: ClientConnection = { port, jobs: new Set(), closed: false };
    this.clients.add(connection);
    port.onMessage.addListener((message) => {
      void this.handleClientMessage(connection, message);
    });
    port.onDisconnect.addListener(() => {
      this.disconnectClient(connection);
    });
  }

  private async handleClientMessage(connection: ClientConnection, value: unknown): Promise<void> {
    if (connection.closed) return;
    if (!isLocalPipelineClientMessage(value)) {
      const jobId = getJobId(value);
      if (jobId) {
        this.postError(connection, jobId, codedError('TRANSFER_PROTOCOL_ERROR', '收到无效的本地流水线消息'));
      }
      return;
    }

    if (value.type === 'prepare') {
      await this.prepareJob(connection, value);
      return;
    }

    if (this.owners.get(value.jobId) !== connection) {
      this.postError(connection, value.jobId, codedError('TRANSFER_PROTOCOL_ERROR', '任务来源与已绑定 Port 不一致'));
      return;
    }
    const job = this.jobs.get(value.jobId);
    if (!job) {
      this.postError(connection, value.jobId, codedError('TRANSFER_PROTOCOL_ERROR', '任务传输状态不存在'));
      return;
    }
    switch (value.type) {
      case 'start':
        if (job.state !== 'prepared') {
          this.rejectJobMessage(
            value.jobId,
            job,
            codedError('TRANSFER_PROTOCOL_ERROR', '任务输入已经开始或结束'),
          );
          return;
        }
        const expectedChars = 4 * Math.ceil(value.file.size / 3);
        const expectedChunks = Math.ceil(expectedChars / LOCAL_PIPELINE_CHUNK_SIZE);
        if (
          value.input.totalChars !== expectedChars
          || value.input.chunkCount !== expectedChunks
        ) {
          this.failJob(value.jobId, codedError(
            'TRANSFER_PROTOCOL_ERROR',
            '任务输入分块声明与文件大小不一致',
          ));
          return;
        }
        job.state = 'receiving';
        job.start = value;
        return;
      case 'input-chunk':
        if (job.state !== 'receiving') {
          this.rejectJobMessage(
            value.jobId,
            job,
            codedError('TRANSFER_PROTOCOL_ERROR', '任务尚未开始接收输入'),
          );
          return;
        }
        if (
          !job.start
          || value.index >= job.start.input.chunkCount
          || job.chunks.has(value.index)
          || job.receivedChars + value.data.length > job.start.input.totalChars
        ) {
          this.failJob(value.jobId, codedError(
            'TRANSFER_PROTOCOL_ERROR',
            '任务输入分块重复、越界或超出声明长度',
          ));
          return;
        }
        job.chunks.set(value.index, value);
        job.receivedChars += value.data.length;
        return;
      case 'input-complete':
        if (job.state !== 'receiving') {
          this.rejectJobMessage(
            value.jobId,
            job,
            codedError('TRANSFER_PROTOCOL_ERROR', '任务输入不能在当前状态结束'),
          );
          return;
        }
        if (
          !job.start
          || job.chunks.size !== job.start.input.chunkCount
          || job.receivedChars !== job.start.input.totalChars
        ) {
          this.failJob(value.jobId, codedError(
            'TRANSFER_PROTOCOL_ERROR',
            '任务输入分块缺失或总长度不符',
          ));
          return;
        }
        job.state = 'queued';
        clearTimeout(job.receiveTimer);
        this.pumpAdmissionQueue();
        this.postAdmissionQueuePositions();
        return;
      case 'cancel':
        if (job.state === 'active' && this.hostPort && this.hostReady) {
          if (!safelyPost(this.hostPort, value)) this.handleHostPostFailure();
          return;
        }
        this.failJob(
          value.jobId,
          new ImagePipelineCancelledError((
            value.reason
            && typeof value.reason === 'object'
          ) ? value.reason : {
            code: typeof value.reason === 'string' ? 'user-requested' : 'unknown',
            messageKey: typeof value.reason === 'string'
              ? 'pipeline.cancelled.userRequested'
              : 'pipeline.cancelled.unknown',
            diagnosticSummary: value.reason || '本地流水线任务已取消',
          } satisfies PipelineCancellationReason),
        );
        this.postAdmissionQueuePositions();
        return;
      default:
        return;
    }
  }

  private async prepareJob(connection: ClientConnection, message: Extract<LocalPipelineClientMessage, { type: 'prepare' }>): Promise<void> {
    const existingOwner = this.owners.get(message.jobId);
    if (existingOwner) {
      this.postError(connection, message.jobId, codedError('TRANSFER_PROTOCOL_ERROR', '任务 ID 已存在'));
      return;
    }
    this.owners.set(message.jobId, connection);
    connection.jobs.add(message.jobId);
    this.jobs.set(message.jobId, {
      diagnosticRunId: message.diagnosticRunId,
      state: 'prepared',
      chunks: new Map(),
      receivedChars: 0,
      receiveTimer: setTimeout(() => {
        const job = this.jobs.get(message.jobId);
        if (!job || job.state === 'active') return;
        this.failJob(message.jobId, codedError(
          'TRANSFER_PROTOCOL_ERROR',
          '任务输入接收超时',
        ));
        this.postAdmissionQueuePositions();
      }, INPUT_RECEIVE_TIMEOUT_MS),
    });
    this.admissionQueue.push(message.jobId);

    try {
      await this.ensurePipelineHost();
      if (connection.closed || this.owners.get(message.jobId) !== connection) {
        return;
      }
      if (!safelyPost(connection.port, {
        type: 'ready',
        jobId: message.jobId,
      } satisfies LocalPipelineHostMessage)) {
        this.releaseJob(message.jobId);
      }
    } catch (error) {
      this.failJob(message.jobId, error);
    }
  }

  private attachHost(port: ExtensionPort): void {
    if (!this.lifecycle.matchesHostPort(port)) {
      port.disconnect();
      return;
    }

    if (this.hostPort && this.hostPort !== port) {
      this.hostPort.disconnect();
    }
    this.hostPort = port;
    this.hostReady = false;
    this.expectedHostClose = false;
    this.pendingIdleClose = false;
    port.onMessage.addListener((message) => {
      void this.handleHostMessage(port, message);
    });
    port.onDisconnect.addListener(() => {
      this.disconnectHost(port);
    });
  }

  private async handleHostMessage(port: ExtensionPort, value: unknown): Promise<void> {
    if (port !== this.hostPort || !isLocalPipelineHostMessage(value)) {
      if (port === this.hostPort) {
        this.handleHostPostFailure(codedError(
          'TRANSFER_PROTOCOL_ERROR',
          '流水线宿主返回了无效消息',
        ));
      }
      return;
    }
    if (value.type === 'host-ready') {
      this.hostReady = true;
      this.resolveHostWaiters(port);
      return;
    }
    if (value.type === 'idle-close') {
      if (this.owners.size === 0) {
        await this.closeIdleHost();
      } else {
        this.pendingIdleClose = true;
      }
      return;
    }

    if (value.type === 'ready' || value.type === 'queued') return;
    const job = this.jobs.get(value.jobId);
    const owner = this.owners.get(value.jobId);
    if (owner && !owner.closed) {
      if (
        job?.terminalError
        && (value.type === 'complete' || value.type === 'error')
      ) {
        safelyPost(owner.port, {
          type: 'error',
          jobId: value.jobId,
          error: serializePipelineError(job.terminalError, 'TRANSFER_PROTOCOL_ERROR'),
        } satisfies LocalPipelineHostMessage);
      } else if (!job?.terminalError) {
        safelyPost(owner.port, value);
      }
    }
    if (value.type === 'complete' || value.type === 'error') {
      this.releaseJob(value.jobId);
      if (this.activeJobId === value.jobId) {
        this.activeJobId = null;
        this.pumpAdmissionQueue();
      }
      this.postAdmissionQueuePositions();
    }
  }

  private disconnectClient(connection: ClientConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.clients.delete(connection);
    for (const jobId of [...connection.jobs]) {
      if (this.activeJobId === jobId && this.hostPort && this.hostReady) {
        if (!safelyPost(this.hostPort, {
          type: 'cancel',
          jobId,
          reason: {
            code: 'transport-disconnected',
            messageKey: 'pipeline.cancelled.transportDisconnected',
            diagnosticSummary: '来源 Port 已断开',
          },
        } satisfies LocalPipelineClientMessage)) {
          this.handleHostPostFailure();
          return;
        }
      }
      this.releaseJob(jobId);
    }
    this.postAdmissionQueuePositions();
  }

  private disconnectHost(port: ExtensionPort): void {
    if (port !== this.hostPort) return;
    this.hostPort = null;
    this.hostReady = false;
    const error = codedError('PIPELINE_HOST_DISCONNECTED', '流水线宿主连接已断开');
    this.rejectHostWaiters(error);
    if (!this.expectedHostClose) {
      this.failAllJobs(error);
    }
    this.activeJobId = null;
    this.admissionQueue.length = 0;
    this.expectedHostClose = false;
  }

  private releaseJob(jobId: string): void {
    const owner = this.owners.get(jobId);
    if (owner) owner.jobs.delete(jobId);
    this.owners.delete(jobId);
    const job = this.jobs.get(jobId);
    if (job) clearTimeout(job.receiveTimer);
    this.jobs.delete(jobId);
    const queueIndex = this.admissionQueue.indexOf(jobId);
    if (queueIndex >= 0) this.admissionQueue.splice(queueIndex, 1);
    if (this.pendingIdleClose && this.owners.size === 0) {
      this.pendingIdleClose = false;
      void this.closeIdleHost();
    }
  }

  private pumpAdmissionQueue(): void {
    if (this.activeJobId || !this.hostPort || !this.hostReady) return;
    while (this.admissionQueue.length > 0) {
      const jobId = this.admissionQueue[0]!;
      const job = this.jobs.get(jobId);
      if (!this.owners.has(jobId) || !job) {
        this.admissionQueue.shift();
        continue;
      }
      if (job.state !== 'queued') return;
      this.admissionQueue.shift();
      const messages: LocalPipelineClientMessage[] = [
        {
          type: 'prepare',
          jobId,
          diagnosticRunId: job.diagnosticRunId,
        },
        job.start!,
        ...[...job.chunks.values()].sort((left, right) => left.index - right.index),
        { type: 'input-complete', jobId },
      ];
      if (!messages.every((message) => safelyPost(this.hostPort!, message))) {
        this.handleHostPostFailure();
        return;
      }
      job.chunks.clear();
      job.start = undefined;
      job.receivedChars = 0;
      job.state = 'active';
      clearTimeout(job.receiveTimer);
      this.activeJobId = jobId;
      const owner = this.owners.get(jobId);
      if (owner && !owner.closed) {
        safelyPost(owner.port, {
          type: 'queued',
          jobId,
          position: 0,
        } satisfies LocalPipelineHostMessage);
      }
      break;
    }
  }

  private rejectJobMessage(jobId: string, job: BufferedJob, error: unknown): void {
    if (job.state !== 'active') {
      this.failJob(jobId, error);
      return;
    }
    if (job.terminalError) return;
    job.terminalError = error;
    if (
      !this.hostPort
      || !this.hostReady
      || !safelyPost(this.hostPort, {
        type: 'cancel',
        jobId,
        reason: {
          code: 'transport-disconnected',
          messageKey: 'pipeline.cancelled.transportDisconnected',
          diagnosticSummary: 'active 任务收到无效传输消息',
        },
      } satisfies LocalPipelineClientMessage)
    ) {
      this.handleHostPostFailure();
    }
  }

  private handleHostPostFailure(error: unknown = codedError(
    'PIPELINE_HOST_DISCONNECTED',
    '向流水线宿主投递任务失败',
  )): void {
    const port = this.hostPort;
    this.hostPort = null;
    this.hostReady = false;
    this.activeJobId = null;
    this.failAllJobs(error);
    this.admissionQueue.length = 0;
    port?.disconnect();
  }

  private postAdmissionQueuePositions(): void {
    this.admissionQueue.forEach((jobId, index) => {
      const owner = this.owners.get(jobId);
      const job = this.jobs.get(jobId);
      if (!owner || owner.closed || job?.state !== 'queued') return;
      safelyPost(owner.port, {
        type: 'queued',
        jobId,
        position: index + (this.activeJobId ? 1 : 0),
      } satisfies LocalPipelineHostMessage);
    });
  }

  private postError(connection: ClientConnection, jobId: string, error: unknown): void {
    safelyPost(connection.port, {
      type: 'error',
      jobId,
      error: serializePipelineError(error, 'TRANSFER_PROTOCOL_ERROR'),
    } satisfies LocalPipelineHostMessage);
  }

  private failJob(jobId: string, error: unknown): void {
    const owner = this.owners.get(jobId);
    if (!owner) return;
    const errorCode = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
    const fallbackCode: LocalPipelineErrorCode = isLocalPipelineErrorCode(errorCode)
      ? errorCode
      : 'PIPELINE_HOST_CREATE_FAILED';
    safelyPost(owner.port, {
      type: 'error',
      jobId,
      error: serializePipelineError(error, fallbackCode),
    } satisfies LocalPipelineHostMessage);
    this.releaseJob(jobId);
    this.pumpAdmissionQueue();
  }

  private failAllJobs(error: unknown): void {
    for (const jobId of [...this.owners.keys()]) {
      this.failJob(jobId, error);
    }
  }

  private async ensurePipelineHost(): Promise<ExtensionPort> {
    if (this.closingPromise) await this.closingPromise;
    if (this.hostPort && this.hostReady) return this.hostPort;
    if (this.creationPromise) return this.creationPromise;

    this.creationPromise = (async () => {
      const attachment = await this.lifecycle.ensureHost();
      if (attachment) {
        this.handlePort(attachment.port);
        attachment.activate();
      }

      try {
        return await this.waitForHost();
      } catch (initialError) {
        // A browser host can outlive a crashed script or retain a stale Port.
        // Recreate it once so the next task is not permanently wedged.
        this.expectedHostClose = true;
        try {
          await this.lifecycle.closeHost();
        } catch {
          // It may already have disappeared while the reconnect was pending.
        }
        this.hostPort = null;
        this.hostReady = false;
        this.expectedHostClose = false;
        const retryAttachment = await this.lifecycle.ensureHost();
        if (retryAttachment) {
          this.handlePort(retryAttachment.port);
          retryAttachment.activate();
        }
        try {
          return await this.waitForHost();
        } catch (retryError) {
          throw createPipelineHostError(
            'PIPELINE_HOST_CREATE_FAILED',
            '重建流水线宿主后仍未建立连接',
            new AggregateError([initialError, retryError], 'pipeline host reconnect attempts failed'),
          );
        }
      }
    })().finally(() => {
      this.creationPromise = null;
    });

    return this.creationPromise;
  }

  private waitForHost(): Promise<ExtensionPort> {
    if (this.hostPort && this.hostReady) return Promise.resolve(this.hostPort);
    return new Promise<ExtensionPort>((resolve, reject) => {
      const waiter: HostWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.hostWaiters.delete(waiter);
          reject(codedError('PIPELINE_HOST_CREATE_FAILED', '等待流水线宿主连接超时'));
        }, PIPELINE_HOST_CONNECT_TIMEOUT_MS),
      };
      this.hostWaiters.add(waiter);
    });
  }

  private resolveHostWaiters(port: ExtensionPort): void {
    for (const waiter of this.hostWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(port);
    }
    this.hostWaiters.clear();
  }

  private rejectHostWaiters(error: unknown): void {
    for (const waiter of this.hostWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.hostWaiters.clear();
  }

  private async closeIdleHost(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    const closingHost = this.hostPort;
    this.expectedHostClose = true;
    this.pendingIdleClose = false;
    const closing = this.lifecycle.closeHost()
      .then(() => {
        if (this.hostPort === closingHost) {
          this.hostPort = null;
          this.hostReady = false;
        }
        this.releaseBackgroundLeases();
      })
      .catch(() => {
        // A rejected close leaves the existing ready Port usable. The next idle
        // signal can retry without forcing a stale-document reconnect timeout.
      })
      .finally(() => {
        this.expectedHostClose = false;
        if (this.closingPromise === closing) this.closingPromise = null;
      });
    this.closingPromise = closing;
    return closing;
  }
}

export function registerPipelineHostBroker(
  api: ExtensionBrowserApi,
  lifecycle: PipelineHostLifecycle,
): PipelineHostBroker {
  const broker = new PipelineHostBroker(api, lifecycle);
  broker.register();
  return broker;
}
