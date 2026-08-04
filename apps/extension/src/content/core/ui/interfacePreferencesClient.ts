import { sendExtensionControlCommand } from '../../../shared/extensionControlTransport';

export type UpdateInterfacePreferences = (
  preferences: { stageTimingCardExpanded?: boolean },
) => Promise<void>;

export const updateInterfacePreferences: UpdateInterfacePreferences = async (
  preferences,
) => {
  const result = await sendExtensionControlCommand({
    kind: 'update-interface-preferences',
    preferences,
  });
  if (result.kind !== 'control-projection') {
    throw new Error('界面偏好更新未返回状态投影');
  }
};
