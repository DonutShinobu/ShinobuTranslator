import {
  isPageArtifactRef,
  PageArtifactQuotaError,
  type PageArtifactKind,
  type PageArtifactRef,
} from '../../../shared/pageArtifacts';
import {
  sendRuntimeMessage,
  type RuntimeMessage,
  type RuntimeResponse,
} from '../../../shared/messages';
import { arrayBufferToBase64 } from '../../../shared/utils';

export type PageArtifactPortProbe =
  | { available: true }
  | { available: false; reason: string };

export interface PageArtifactPort {
  probe(): Promise<PageArtifactPortProbe>;
  put(input: { kind: PageArtifactKind; file: File }): Promise<PageArtifactRef>;
  read(ref: PageArtifactRef): Promise<File>;
  delete(ref: PageArtifactRef): Promise<void>;
  clear(): Promise<void>;
}

export type PageArtifactRuntimeSender = (
  message: RuntimeMessage,
) => Promise<RuntimeResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeWireFile(value: unknown): File {
  if (
    !isRecord(value)
    || typeof value.base64 !== 'string'
    || typeof value.contentType !== 'string'
    || typeof value.filename !== 'string'
  ) {
    throw new Error('页面产物服务返回了无效文件');
  }
  const binary = atob(value.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], value.filename, { type: value.contentType });
}

export class RuntimePageArtifactPort implements PageArtifactPort {
  constructor(
    private readonly contentSessionId: string,
    private readonly send: PageArtifactRuntimeSender = sendRuntimeMessage,
  ) {}

  async probe(): Promise<PageArtifactPortProbe> {
    const result = await this.request({
      operation: 'probe',
      contentSessionId: this.contentSessionId,
    });
    if (isRecord(result) && result.available === true) return { available: true };
    if (
      isRecord(result)
      && result.available === false
      && typeof result.reason === 'string'
    ) {
      return { available: false, reason: result.reason };
    }
    throw new Error('页面产物服务返回了无效能力结果');
  }

  async put(input: { kind: PageArtifactKind; file: File }): Promise<PageArtifactRef> {
    const result = await this.request({
      operation: 'put',
      contentSessionId: this.contentSessionId,
      kind: input.kind,
      file: {
        base64: arrayBufferToBase64(await input.file.arrayBuffer()),
        contentType: input.file.type,
        filename: input.file.name,
      },
    });
    if (!isPageArtifactRef(result)) throw new Error('页面产物服务返回了无效引用');
    return result;
  }

  async read(ref: PageArtifactRef): Promise<File> {
    return decodeWireFile(await this.request({
      operation: 'read',
      contentSessionId: this.contentSessionId,
      ref,
    }));
  }

  async delete(ref: PageArtifactRef): Promise<void> {
    await this.request({
      operation: 'delete',
      contentSessionId: this.contentSessionId,
      ref,
    });
  }

  async clear(): Promise<void> {
    await this.request({
      operation: 'clear',
      contentSessionId: this.contentSessionId,
    });
  }

  private async request(
    command: Extract<RuntimeMessage, { type: 'mt:page-artifact' }>['command'],
  ): Promise<unknown> {
    const response = await this.send({ type: 'mt:page-artifact', command });
    if (!response.ok) {
      if (response.errorCode === 'page_artifact_quota') {
        throw new PageArtifactQuotaError(response.error);
      }
      throw new Error(response.error);
    }
    if (response.type !== 'mt:page-artifact') {
      throw new Error('页面产物服务返回了错误的消息类型');
    }
    return response.result;
  }
}
