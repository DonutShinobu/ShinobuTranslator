import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultExtensionSettings } from '../../../apps/extension/src/shared/config';
import { ScreenshotController } from '../../../apps/extension/src/content/core/screenshot/screenshotController';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import { CardStateController } from '../../../apps/extension/src/content/core/ui/cardState';
import { createImageTranslationExecutionModule } from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { createImageTranslationExecutionArbiter } from '../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter';

const mocks = vi.hoisted(() => ({
  cropScreenshotToFile: vi.fn(),
  sendRuntimeMessage: vi.fn(),
}));

vi.mock('../../../apps/extension/src/shared/messages', () => ({
  sendRuntimeMessage: mocks.sendRuntimeMessage,
}));

vi.mock('../../../apps/extension/src/content/core/screenshot', () => ({
  cropScreenshotToFile: mocks.cropScreenshotToFile,
  toViewportScreenshotRect: vi.fn((rect) => rect),
}));

vi.mock('../../../apps/extension/src/content/core/ui', () => ({
  createScreenshotResultUi: vi.fn(() => ({
    host: {
      style: { visibility: '' },
      remove: vi.fn(),
    },
    button: { addEventListener: vi.fn() },
    closeButton: { addEventListener: vi.fn() },
    stageTimingCardToggleButton: { addEventListener: vi.fn() },
    errorDetailCardToggleButton: { addEventListener: vi.fn() },
  })),
  repositionScreenshotResultOverlay: vi.fn(),
  renderScreenshotResultUi: vi.fn(),
  requestScreenshotSelection: vi.fn(),
  setScreenshotResultRect: vi.fn(),
}));

vi.mock('../../../apps/extension/src/content/core/screenshot/overlayInteraction', () => ({
  attachScreenshotResultDrag: vi.fn(() => vi.fn()),
  attachScreenshotResultZoom: vi.fn(() => vi.fn()),
  resolveContextImageAnchorRects: vi.fn(),
}));

vi.mock('../../../apps/extension/src/content/core/progressJank', () => ({
  ProgressJankMonitor: class {
    start(): void {}
    setStage(): void {}
    measureUiRender(callback: () => void): void {
      callback();
    }
    finish() {
      return { runId: 'screenshot-arbitration-test', entry: 'screenshot' };
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mocks.cropScreenshotToFile.mockReset();
  mocks.sendRuntimeMessage.mockReset();
});

describe('ScreenshotController arbitration', () => {
  it('projects preemption during capture as cancellation without cropping or translating', async () => {
    const capture = deferred<{
      ok: true;
      type: 'mt:capture-visible-tab';
      base64: string;
      contentType: string;
    }>();
    mocks.sendRuntimeMessage.mockReturnValue(capture.promise);
    vi.stubGlobal('document', {
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal('window', {
      innerWidth: 1280,
      innerHeight: 720,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
    });
    vi.spyOn(Date, 'now').mockReturnValue(123);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
    const executionModule = createImageTranslationExecutionModule({
      loadSettings: async () => ({ ...defaultExtensionSettings }),
    });
    const startExecution = vi.spyOn(executionModule, 'start');
    const executionArbiter = createImageTranslationExecutionArbiter(executionModule);
    const controller = new ScreenshotController(
      store,
      executionArbiter,
      new CardStateController(),
    );

    const pending = controller.translateScreenshotSelection({
      viewportRect: { left: 10, top: 20, width: 300, height: 200 },
      documentRect: { left: 10, top: 120, width: 300, height: 200 },
    });
    await vi.waitFor(() => expect(mocks.sendRuntimeMessage).toHaveBeenCalledOnce());

    const replacement = executionArbiter.begin({
      owner: 'inline-image',
      origin: 'explicit',
    });
    capture.resolve({
      ok: true,
      type: 'mt:capture-visible-tab',
      base64: 'captured',
      contentType: 'image/png',
    });
    await pending;

    expect(mocks.cropScreenshotToFile).not.toHaveBeenCalled();
    expect(startExecution).not.toHaveBeenCalled();
    expect(store.get('screenshot-123-i')).toMatchObject({
      status: 'idle',
      mode: 'original',
      errorText: '',
    });
    if (replacement.status === 'active') replacement.activity.end();
  });
});
