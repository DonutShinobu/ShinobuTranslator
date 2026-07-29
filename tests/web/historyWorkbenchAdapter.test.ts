import { describe, expect, it, vi } from 'vitest';
import { createDefaultWebSettings } from '../../packages/shared-config/src';
import { createHistoryWorkbenchAdapter } from '../../apps/web/src/features/history/historyWorkbenchAdapter';
import type { LocalHistoryBatch } from '../../apps/web/src/features/history/localHistory';
import type { ImportedImage } from '../../apps/web/src/features/import/imageImporter';

function sourceFile(): File {
  return new File(['original'], 'page.png', { type: 'image/png' });
}

function importedImage(): ImportedImage {
  return {
    id: 'new-image-id',
    file: sourceFile(),
    format: 'png',
    width: 1200,
    height: 1800,
    pixelCount: 2_160_000,
    thumbnailUrl: 'blob:thumbnail',
    duplicate: false,
    workingCopy: {
      required: false,
      width: 1200,
      height: 1800,
      scale: 1,
    },
  };
}

function batch(providerId = 'openai'): LocalHistoryBatch {
  return {
    schemaVersion: 3,
    id: 'batch-1',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    status: 'paused',
    rerunnable: true,
    lockedConfig: {
      schemaVersion: 1,
      targetLanguage: 'zh-CHS',
      processMode: 'translate',
      provider: {
        id: providerId,
        target: 'https://locked.example/v1',
        model: 'locked-model',
      },
    },
    versions: {
      app: '0.1.0',
      core: '0.8.1',
      model: 'model-v1',
      configSchema: 1,
    },
    recoveryPoint: {
      savedAt: '2026-07-29T00:00:00.000Z',
      nextItemIndex: 0,
    },
    items: [{
      id: 'image-1',
      order: 0,
      width: 1200,
      height: 1800,
      workingCopy: {
        required: false,
        width: 1200,
        height: 1800,
        scale: 1,
      },
      status: 'queued',
      original: {
        path: 'batch-1/items/0/original',
        fileName: 'page.png',
        mediaType: 'image/png',
        size: 'original'.length,
      },
    }],
  };
}

const copy = {
  historyOriginalValidationFailed: 'validation failed',
  historyProviderUnavailable: 'provider unavailable',
  historyRecoveryLoadedDetail: 'restored',
};

describe('history workbench adapter', () => {
  it('leaves the host unchanged when current image validation rejects any original', async () => {
    const installRecovery = vi.fn();
    const current = createDefaultWebSettings('zh-TW');
    const adapter = createHistoryWorkbenchAdapter({
      importer: {
        importFiles: async () => ({
          accepted: [],
          rejected: [{ file: sourceFile(), code: 'decode-failed' }],
        }),
      },
      copy,
      host: {
        occupied: () => false,
        currentSettings: () => current,
        installRecovery,
        installDraft: vi.fn(),
        discardRecovery: vi.fn(),
      },
    });

    await expect(adapter.installRecovery({
      kind: 'recovery',
      batch: batch(),
      files: [sourceFile()],
    })).rejects.toThrow('validation failed');
    expect(installRecovery).not.toHaveBeenCalled();
  });

  it('restores only locked processing fields and preserves locale and unselected providers', async () => {
    const current = createDefaultWebSettings('zh-TW');
    current.providerProfiles.deepseek.model = 'keep-current-model';
    const installRecovery = vi.fn();
    const adapter = createHistoryWorkbenchAdapter({
      importer: {
        importFiles: async () => ({ accepted: [importedImage()], rejected: [] }),
      },
      copy,
      host: {
        occupied: () => false,
        currentSettings: () => current,
        installRecovery,
        installDraft: vi.fn(),
        discardRecovery: vi.fn(),
      },
    });

    await adapter.installRecovery({
      kind: 'recovery',
      batch: batch(),
      files: [sourceFile()],
    });

    expect(installRecovery).toHaveBeenCalledWith(expect.objectContaining({
      batch: expect.objectContaining({ id: 'batch-1' }),
      images: [expect.objectContaining({ id: 'image-1' })],
      settings: expect.objectContaining({
        uiLocale: 'zh-TW',
        translationProviderId: 'openai',
        providerProfiles: expect.objectContaining({
          deepseek: expect.objectContaining({ model: 'keep-current-model' }),
          openai: {
            baseUrl: 'https://locked.example/v1',
            model: 'locked-model',
          },
        }),
      }),
    }));
  });

  it('creates an editable draft that requires a current provider when the old one is gone', async () => {
    const current = createDefaultWebSettings('zh-CN');
    const installDraft = vi.fn();
    const adapter = createHistoryWorkbenchAdapter({
      importer: {
        importFiles: async () => ({ accepted: [importedImage()], rejected: [] }),
      },
      copy,
      host: {
        occupied: () => false,
        currentSettings: () => current,
        installRecovery: vi.fn(),
        installDraft,
        discardRecovery: vi.fn(),
      },
    });

    await adapter.installDraft({
      kind: 'draft',
      sourceBatch: batch('removed-provider'),
      files: [sourceFile()],
      providerSelectionRequired: true,
    });

    expect(installDraft).toHaveBeenCalledWith(expect.objectContaining({
      providerSelectionRequired: true,
      settings: expect.objectContaining({
        uiLocale: 'zh-CN',
        translationProviderId: current.translationProviderId,
        targetLanguage: 'zh-CHS',
        processMode: 'translate',
      }),
    }));
  });
});
