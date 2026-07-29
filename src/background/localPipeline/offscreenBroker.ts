import type { ChromeLike, ChromePort } from '../../shared/chrome';
import {
  ImagePipelineCancelledError,
  type PipelineCancellationReason,
} from '@shinobu/image-pipeline';
import {
  LOCAL_PIPELINE_CLIENT_PORT,
  LOCAL_PIPELINE_CHUNK_SIZE,
  LOCAL_PIPELINE_OFFSCREEN_DOCUMENT,
  LOCAL_PIPELINE_OFFSCREEN_PORT,
  isLocalPipelineClientMessage,
  isLocalPipelineErrorCode,
  isLocalPipelineHostMessage,
  serializePipelineError,
  type LocalPipelineClientMessage,
  type LocalPipelineErrorCode,
  type LocalPipelineHostMessage,
} from '../../shared/localPipelineProtocol';

const OFFSCREEN_CONNECT_TIMEOUT_MS = 10_000;

type ClientConnection = {
  port: ChromePort;
  jobs: Set<string>;
  closed: boolean;
};

type HostWaiter = {
  resolve: (port: ChromePort) => void;
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
  error.name = 'OffscreenPipelineError';
  error.code = code;
  return error;
}

function getJobId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const jobId = (value as { jobId?: unknown }).jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
}

function safelyPost(port: ChromePort, message: unknown): boolean {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

export class OffscreenPipelineBroker {
  private readonly clients = new Set<ClientConnection>();
  private readonly owners = new Map<string, ClientConnection>();
  private readonly jobs = new Map<string, BufferedJob>();
  private hostPort: ChromePort | null = null;
  private hostReady = false;
  private hostWaiters = new Set<HostWaiter>();
  private creationPromise: Promise<ChromePort> | null = null;
  private expectedHostClose = false;
  private closingPromise: Promise<void> | null = null;
  private readonly admissionQueue: string[] = [];
  private activeJobId: string | null = null;
  private pendingIdleClose = false;

  constructor(private readonly chromeApi: ChromeLike) {}

  register(): void {
    this.chromeApi.runtime?.onConnect?.addListener((port) => this.handlePort(port));
  }

  handlePort(port: ChromePort): void {
    if (port.name === LOCAL_PIPELINE_OFFSCREEN_PORT) {
      this.attachHost(port);
      return;
    }
    if (port.name === LOCAL_PIPELINE_CLIENT_PORT) {
      this.attachClient(port);
      return;
    }
    port.disconnect();
  }

  private attachClient(port: ChromePort): void {
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
      await this.ensureOffscreenHost();
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

  private attachHost(port: ChromePort): void {
    const expectedUrl = this.chromeApi.runtime?.getURL?.(LOCAL_PIPELINE_OFFSCREEN_DOCUMENT);
    const actualUrl = port.sender?.documentUrl;
    if (expectedUrl && actualUrl && actualUrl !== expectedUrl) {
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

  private async handleHostMessage(port: ChromePort, value: unknown): Promise<void> {
    if (port !== this.hostPort || !isLocalPipelineHostMessage(value)) {
      if (port === this.hostPort) {
        this.handleHostPostFailure(codedError(
          'TRANSFER_PROTOCOL_ERROR',
          'offscreen 返回了无效消息',
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
        await this.closeIdleDocument();
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

  private disconnectHost(port: ChromePort): void {
    if (port !== this.hostPort) return;
    this.hostPort = null;
    this.hostReady = false;
    const error = codedError('OFFSCREEN_DISCONNECTED', 'offscreen 流水线连接已断开');
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
      void this.closeIdleDocument();
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
    'OFFSCREEN_DISCONNECTED',
    '向 offscreen 流水线投递任务失败',
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
      : 'OFFSCREEN_CREATE_FAILED';
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

  private async ensureOffscreenHost(): Promise<ChromePort> {
    if (this.closingPromise) await this.closingPromise;
    if (this.hostPort && this.hostReady) return this.hostPort;
    if (this.creationPromise) return this.creationPromise;

    this.creationPromise = (async () => {
      const offscreenApi = this.chromeApi.offscreen;
      if (!offscreenApi?.createDocument) {
        throw codedError('OFFSCREEN_UNAVAILABLE', '当前 Chromium 不支持扩展 offscreen document');
      }

      const exists = await this.hasOffscreenDocument();
      if (!exists) {
        await this.createOffscreenDocument(offscreenApi);
      }

      try {
        return await this.waitForHost();
      } catch (initialError) {
        // An offscreen document can outlive a crashed script or a stale Port.
        // Recreate it once so the next task is not permanently wedged.
        if (!offscreenApi.closeDocument) throw initialError;
        this.expectedHostClose = true;
        try {
          await offscreenApi.closeDocument();
        } catch {
          // It may already have disappeared between getContexts and close.
        }
        this.hostPort = null;
        this.hostReady = false;
        this.expectedHostClose = false;
        await this.createOffscreenDocument(offscreenApi);
        try {
          return await this.waitForHost();
        } catch (retryError) {
          throw codedError(
            'OFFSCREEN_CREATE_FAILED',
            '重建 offscreen document 后仍未建立流水线连接',
            new AggregateError([initialError, retryError], 'offscreen reconnect attempts failed'),
          );
        }
      }
    })().finally(() => {
      this.creationPromise = null;
    });

    return this.creationPromise;
  }

  private async createOffscreenDocument(offscreenApi: NonNullable<ChromeLike['offscreen']>): Promise<void> {
    if (!offscreenApi.createDocument) {
      throw codedError('OFFSCREEN_UNAVAILABLE', '当前 Chromium 不支持扩展 offscreen document');
    }
    try {
      await offscreenApi.createDocument({
        url: LOCAL_PIPELINE_OFFSCREEN_DOCUMENT,
        reasons: ['WORKERS'],
        justification: '在扩展同源上下文中运行本地 ONNX 图片翻译流水线',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/single offscreen|already exists|only one offscreen/i.test(message)) {
        throw codedError('OFFSCREEN_CREATE_FAILED', `创建 offscreen document 失败: ${message}`, error);
      }
    }
  }

  private async hasOffscreenDocument(): Promise<boolean> {
    const targetUrl = this.chromeApi.runtime?.getURL?.(LOCAL_PIPELINE_OFFSCREEN_DOCUMENT);
    if (!targetUrl) return false;
    const runtimeApi = this.chromeApi.runtime;
    if (runtimeApi?.getContexts) {
      const contexts = await runtimeApi.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [targetUrl],
      });
      return contexts.length > 0;
    }

    const serviceWorkerScope = globalThis as typeof globalThis & {
      clients?: { matchAll: () => Promise<Array<{ url: string }>> };
    };
    if (serviceWorkerScope.clients?.matchAll) {
      const clients = await serviceWorkerScope.clients.matchAll();
      return clients.some((client) => client.url === targetUrl);
    }
    return false;
  }

  private waitForHost(): Promise<ChromePort> {
    if (this.hostPort && this.hostReady) return Promise.resolve(this.hostPort);
    return new Promise<ChromePort>((resolve, reject) => {
      const waiter: HostWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.hostWaiters.delete(waiter);
          reject(codedError('OFFSCREEN_CREATE_FAILED', '等待 offscreen 流水线连接超时'));
        }, OFFSCREEN_CONNECT_TIMEOUT_MS),
      };
      this.hostWaiters.add(waiter);
    });
  }

  private resolveHostWaiters(port: ChromePort): void {
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

  private async closeIdleDocument(): Promise<void> {
    if (!this.chromeApi.offscreen?.closeDocument) return;
    if (this.closingPromise) return this.closingPromise;
    const closingHost = this.hostPort;
    this.expectedHostClose = true;
    this.pendingIdleClose = false;
    const closing = this.chromeApi.offscreen.closeDocument()
      .then(() => {
        if (this.hostPort === closingHost) {
          this.hostPort = null;
          this.hostReady = false;
        }
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

export function registerOffscreenPipelineBroker(chromeApi: ChromeLike): OffscreenPipelineBroker {
  const broker = new OffscreenPipelineBroker(chromeApi);
  broker.register();
  return broker;
}
