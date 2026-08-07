import { sendRuntimeMessage } from '../../../shared/messages';

export type VisibleTabCapture = {
  dataUrl: string;
  viewport: { width: number; height: number };
};

export interface VisibleTabCapturePort {
  capture(): Promise<VisibleTabCapture>;
}

export class RuntimeVisibleTabCapturePort implements VisibleTabCapturePort {
  async capture(): Promise<VisibleTabCapture> {
    const response = await sendRuntimeMessage({ type: 'mt:capture-visible-tab' });
    if (!response.ok) throw new Error(response.error);
    if (response.type !== 'mt:capture-visible-tab') {
      throw new Error('截图服务返回了错误消息');
    }
    return {
      dataUrl: `data:${response.contentType};base64,${response.base64}`,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }
}
