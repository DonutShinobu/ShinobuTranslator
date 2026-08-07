import {
  sendRuntimeMessage,
  type RuntimeMessage,
  type RuntimeResponse,
} from '../../../shared/messages';

export interface ContinuousTabStatePort {
  read(): Promise<boolean>;
  write(enabled: boolean): Promise<void>;
}

type RuntimeSender = (message: RuntimeMessage) => Promise<RuntimeResponse>;

export class RuntimeContinuousTabStatePort implements ContinuousTabStatePort {
  constructor(private readonly send: RuntimeSender = sendRuntimeMessage) {}

  async read(): Promise<boolean> {
    return this.request({ operation: 'read' });
  }

  async write(enabled: boolean): Promise<void> {
    await this.request({ operation: 'write', enabled });
  }

  private async request(
    command: Extract<RuntimeMessage, { type: 'mt:continuous-tab-state' }>['command'],
  ): Promise<boolean> {
    const response = await this.send({
      type: 'mt:continuous-tab-state',
      command,
    });
    if (!response.ok) throw new Error(response.error);
    if (response.type !== 'mt:continuous-tab-state') {
      throw new Error('连续翻译标签页状态服务返回了错误消息');
    }
    return response.result.enabled;
  }
}
