import type {
  NativeCommands,
} from '../../apps/extension/src/capabilities/contracts';

export const shortcutCommandDefinitions = [
  { name: 'start-screenshot-translate', label: '截图翻译' },
  { name: 'translate-hover-target', label: '翻译悬停元素' },
] as const;

export type ShortcutCommandName =
  typeof shortcutCommandDefinitions[number]['name'];

export type ShortcutState = Record<ShortcutCommandName, string>;

export const defaultShortcutState: ShortcutState = {
  'start-screenshot-translate': '',
  'translate-hover-target': '',
};

export async function loadShortcutState(
  commands: NativeCommands,
): Promise<ShortcutState> {
  const bindings = await commands.bindings();
  const shortcuts: ShortcutState = { ...defaultShortcutState };
  for (const definition of shortcutCommandDefinitions) {
    const binding = bindings.find(
      ({ command }) => command === definition.name,
    );
    shortcuts[definition.name] = binding?.shortcut ?? '';
  }
  return shortcuts;
}
