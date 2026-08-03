import type {
  ExtensionBrowserApi,
  ExtensionPort,
} from '../../shared/extensionRuntime';
import type { LocalPipelineErrorCode } from '../../shared/localPipelineProtocol';

export interface PipelineHostLifecycle {
  ensureHost(): Promise<PipelineHostAttachment | undefined>;
  closeHost(): Promise<void>;
  matchesHostPort(port: ExtensionPort): boolean;
}

export interface PipelineHostAttachment {
  readonly port: ExtensionPort;
  activate(): void;
}

export function createPipelineHostError(
  code: Extract<
    LocalPipelineErrorCode,
    | 'PIPELINE_HOST_UNAVAILABLE'
    | 'PIPELINE_HOST_CREATE_FAILED'
    | 'PIPELINE_HOST_DISCONNECTED'
  >,
  message: string,
  cause?: unknown,
): Error & { code: LocalPipelineErrorCode } {
  const error = new Error(
    message,
    cause === undefined ? undefined : { cause },
  ) as Error & { code: LocalPipelineErrorCode };
  error.name = 'PipelineHostError';
  error.code = code;
  return error;
}

export class ChromiumPipelineHostLifecycle implements PipelineHostLifecycle {
  static readonly documentPath = 'offscreen.html';

  constructor(private readonly api: ExtensionBrowserApi) {}

  matchesHostPort(port: ExtensionPort): boolean {
    const expectedUrl = this.api.runtime?.getURL?.(
      ChromiumPipelineHostLifecycle.documentPath,
    );
    const actualUrl = port.sender?.documentUrl;
    return !expectedUrl || !actualUrl || actualUrl === expectedUrl;
  }

  async ensureHost(): Promise<undefined> {
    const offscreen = this.api.offscreen;
    if (!offscreen?.createDocument) {
      throw createPipelineHostError(
        'PIPELINE_HOST_UNAVAILABLE',
        '当前 Chromium 不支持扩展流水线宿主',
      );
    }
    if (await this.hasHost()) return undefined;
    try {
      await offscreen.createDocument({
        url: ChromiumPipelineHostLifecycle.documentPath,
        reasons: ['WORKERS'],
        justification: '在扩展同源上下文中运行本地 ONNX 图片翻译流水线',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/single offscreen|already exists|only one offscreen/i.test(message)) {
        throw createPipelineHostError(
          'PIPELINE_HOST_CREATE_FAILED',
          `创建流水线宿主失败: ${message}`,
          error,
        );
      }
    }
    return undefined;
  }

  async closeHost(): Promise<void> {
    await this.api.offscreen?.closeDocument?.();
  }

  private async hasHost(): Promise<boolean> {
    const targetUrl = this.api.runtime?.getURL?.(
      ChromiumPipelineHostLifecycle.documentPath,
    );
    if (!targetUrl) return false;
    if (this.api.runtime?.getContexts) {
      const contexts = await this.api.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [targetUrl],
      });
      return contexts.length > 0;
    }
    const workerScope = globalThis as typeof globalThis & {
      clients?: { matchAll: () => Promise<Array<{ url: string }>> };
    };
    const clients = await workerScope.clients?.matchAll();
    return clients?.some((client) => client.url === targetUrl) ?? false;
  }
}
