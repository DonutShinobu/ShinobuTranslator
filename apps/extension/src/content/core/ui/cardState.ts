import { sendRuntimeMessage } from '../../../shared/messages';
import type { PhotoState } from '../types';

export class CardStateController {
  constructor(private readonly sendMessage: typeof sendRuntimeMessage = sendRuntimeMessage) {}

  toggleStageTimingCard(state: PhotoState, render: () => void): void {
    if (!state.stageTimingCard) return;
    const expanded = !state.stageTimingCard.expanded;
    state.stageTimingCard.expanded = expanded;
    render();
    void this.persistStageTimingCardExpanded(expanded);
  }

  toggleErrorDetailCard(state: PhotoState, render: () => void): void {
    if (!state.errorDetailCard) return;
    state.errorDetailCard.expanded = !state.errorDetailCard.expanded;
    render();
  }

  private async persistStageTimingCardExpanded(expanded: boolean): Promise<void> {
    try {
      const settingsResponse = await this.sendMessage({ type: 'mt:get-settings' });
      if (!settingsResponse.ok || settingsResponse.type !== 'mt:get-settings') {
        throw new Error(settingsResponse.ok ? '读取配置失败' : settingsResponse.error);
      }
      const response = await this.sendMessage({
        type: 'mt:set-settings',
        settings: {
          ...settingsResponse.settings,
          stageTimingCardExpanded: expanded,
        },
      });
      if (!response.ok || response.type !== 'mt:set-settings') {
        throw new Error(response.ok ? '保存阶段明细状态失败' : response.error);
      }
    } catch (error) {
      console.warn('[shinobu] 保存阶段明细展开状态失败', error);
    }
  }
}
