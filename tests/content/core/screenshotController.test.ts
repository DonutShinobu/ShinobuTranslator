import { describe, expect, it, vi } from 'vitest';
import type { ScreenshotSelection } from '../../../apps/extension/src/content/core/screenshot';
import { ScreenshotController } from '../../../apps/extension/src/content/core/screenshot/screenshotController';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import { createImageTranslationExecutionModule } from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { createImageTranslationExecutionArbiter } from '../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter';
import { CardStateController } from '../../../apps/extension/src/content/core/ui/cardState';
import { prepareExecutionFromSettings } from './executionPreparation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('ScreenshotController', () => {
  it('deduplicates an in-flight selection request', async () => {
    const selection = deferred<ScreenshotSelection | null>();
    const requestSelection = vi.fn(() => selection.promise);
    const controller = new ScreenshotController(
      new PhotoStateStore(200, { revokeObjectURL: vi.fn() }),
      createImageTranslationExecutionArbiter(createImageTranslationExecutionModule({
        prepareExecution: prepareExecutionFromSettings(),
      })),
      new CardStateController(),
      requestSelection,
    );

    const first = controller.startScreenshotTranslate();
    const second = controller.startScreenshotTranslate();
    expect(requestSelection).toHaveBeenCalledOnce();

    selection.resolve(null);
    await Promise.all([first, second]);
  });

  it('drops a stale selection result after disposal', async () => {
    const selection = deferred<ScreenshotSelection | null>();
    const controller = new ScreenshotController(
      new PhotoStateStore(200, { revokeObjectURL: vi.fn() }),
      createImageTranslationExecutionArbiter(createImageTranslationExecutionModule({
        prepareExecution: prepareExecutionFromSettings(),
      })),
      new CardStateController(),
      () => selection.promise,
    );
    const translate = vi.spyOn(controller, 'translateScreenshotSelection').mockResolvedValue();
    const pending = controller.startScreenshotTranslate();

    controller.dispose();
    selection.resolve({
      viewportRect: { left: 1, top: 2, width: 30, height: 40 },
      documentRect: { left: 11, top: 22, width: 30, height: 40 },
    });
    await pending;

    expect(translate).not.toHaveBeenCalled();
  });
});
