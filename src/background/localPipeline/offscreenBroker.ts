import type { ChromeLike, ChromePort } from '../../shared/chrome';
import {
  LOCAL_PIPELINE_CLIENT_PORT,
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
  private hostPort: ChromePort | null = null;
  private hostReady = false;
  private hostWaiters = new Set<HostWaiter>();
  private creationPromise: Promise<ChromePort> | null = null;
  private expectedHostClose = false;

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
    if (!this.hostPort || !this.hostReady) {
      this.failJob(value.jobId, codedError('OFFSCREEN_DISCONNECTED', 'offscreen 流水线连接已断开'));
      return;
    }
    safelyPost(this.hostPort, value);
  }

  private async prepareJob(connection: ClientConnection, message: Extract<LocalPipelineClientMessage, { type: 'prepare' }>): Promise<void> {
    const existingOwner = this.owners.get(message.jobId);
    if (existingOwner) {
      this.postError(connection, message.jobId, codedError('TRANSFER_PROTOCOL_ERROR', '任务 ID 已存在'));
      return;
    }
    this.owners.set(message.jobId, connection);
    connection.jobs.add(message.jobId);

    try {
      const host = await this.ensureOffscreenHost();
      if (connection.closed || this.owners.get(message.jobId) !== connection) {
        return;
      }
      safelyPost(host, message);
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
        this.failAllJobs(codedError('TRANSFER_PROTOCOL_ERROR', 'offscreen 返回了无效消息'));
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
      }
      return;
    }

    const owner = this.owners.get(value.jobId);
    if (!owner || owner.closed) return;
    safelyPost(owner.port, value);
    if (value.type === 'complete' || value.type === 'error') {
      this.releaseJob(value.jobId);
    }
  }

  private disconnectClient(connection: ClientConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.clients.delete(connection);
    for (const jobId of [...connection.jobs]) {
      if (this.hostPort && this.hostReady) {
        safelyPost(this.hostPort, {
          type: 'cancel',
          jobId,
          reason: '来源 Port 已断开',
        } satisfies LocalPipelineClientMessage);
      }
      this.releaseJob(jobId);
    }
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
    this.expectedHostClose = false;
  }

  private releaseJob(jobId: string): void {
    const owner = this.owners.get(jobId);
    if (owner) owner.jobs.delete(jobId);
    this.owners.delete(jobId);
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
  }

  private failAllJobs(error: unknown): void {
    for (const jobId of [...this.owners.keys()]) {
      this.failJob(jobId, error);
    }
  }

  private async ensureOffscreenHost(): Promise<ChromePort> {
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
    this.expectedHostClose = true;
    try {
      await this.chromeApi.offscreen.closeDocument();
    } finally {
      this.hostPort = null;
      this.hostReady = false;
      this.expectedHostClose = false;
    }
  }
}

export function registerOffscreenPipelineBroker(chromeApi: ChromeLike): OffscreenPipelineBroker {
  const broker = new OffscreenPipelineBroker(chromeApi);
  broker.register();
  return broker;
}
