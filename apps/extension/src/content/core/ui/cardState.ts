import type { PhotoState } from '../types';
import {
  updateInterfacePreferences,
  type UpdateInterfacePreferences,
} from './interfacePreferencesClient';

export class CardStateController {
  constructor(
    private readonly updatePreferences: UpdateInterfacePreferences = updateInterfacePreferences,
  ) {}

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
      await this.updatePreferences({
        stageTimingCardExpanded: expanded,
      });
    } catch (error) {
      console.warn('[shinobu] 保存阶段明细展开状态失败', error);
    }
  }
}
