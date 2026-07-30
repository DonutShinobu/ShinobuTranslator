import { describe, expect, it, vi } from 'vitest';
import {
  loadShortcutState,
} from '../../src/popup/shortcuts';

describe('popup shortcuts', () => {
  it('reads stable shortcut bindings through native command capabilities', async () => {
    const commands = {
      bindings: vi.fn(async () => [
        {
          command: 'start-screenshot-translate',
          description: 'Screenshot translate',
          shortcut: 'Alt+S',
        },
        {
          command: 'translate-hover-target',
          description: 'Translate hovered target',
          shortcut: 'Alt+T',
        },
        {
          command: 'unrelated-command',
          shortcut: 'Alt+U',
        },
      ]),
      onTriggered: vi.fn(() => () => {}),
      openSettings: vi.fn(async () => {}),
    };

    await expect(loadShortcutState(commands)).resolves.toEqual({
      'start-screenshot-translate': 'Alt+S',
      'translate-hover-target': 'Alt+T',
    });
  });
});
