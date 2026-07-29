import {
  createWebSettingsDraftFromLockedConfig,
  restoreWebSettingsFromLockedConfig,
  type WebSettings,
} from '@shinobu/shared-config';
import type { AppCopy } from '../../i18n';
import type {
  ImageImporter,
  ImportedImage,
} from '../import/imageImporter';
import type { QueueJobState } from '../processing/processingBatchHost';
import type { LocalHistoryBatch } from './localHistory';
import type { LocalHistoryWorkbenchAdapter } from './localHistoryLifecycle';

export type RecoveryWorkbenchInstallation = {
  batch: LocalHistoryBatch;
  images: ImportedImage[];
  jobs: Record<string, QueueJobState>;
  settings: WebSettings;
};

export type DraftWorkbenchInstallation = {
  images: ImportedImage[];
  settings: WebSettings;
  providerSelectionRequired: boolean;
};

export type HistoryWorkbenchHost = {
  occupied(): boolean;
  currentSettings(): WebSettings;
  installRecovery(installation: RecoveryWorkbenchInstallation): void;
  installDraft(installation: DraftWorkbenchInstallation): void;
  discardRecovery(batchId: string): void;
};

type HistoryWorkbenchCopy = Pick<
  AppCopy,
  | 'historyOriginalValidationFailed'
  | 'historyProviderUnavailable'
  | 'historyRecoveryLoadedDetail'
>;

function releaseImportedImages(images: readonly ImportedImage[]): void {
  images.forEach((image) => URL.revokeObjectURL(image.thumbnailUrl));
}

export function createHistoryWorkbenchAdapter(input: {
  importer: ImageImporter;
  copy: HistoryWorkbenchCopy;
  host: HistoryWorkbenchHost;
}): LocalHistoryWorkbenchAdapter {
  const { importer, copy, host } = input;
  return {
    occupied: () => host.occupied(),
    async installRecovery(preparation) {
      const orderedItems = [...preparation.batch.items]
        .sort((left, right) => left.order - right.order);
      const imported = await importer.importFiles(preparation.files, []);
      if (imported.accepted.length !== orderedItems.length) {
        releaseImportedImages(imported.accepted);
        throw new Error(copy.historyOriginalValidationFailed);
      }
      const settings = restoreWebSettingsFromLockedConfig(
        preparation.batch.lockedConfig,
        host.currentSettings(),
      );
      if (!settings) {
        releaseImportedImages(imported.accepted);
        throw new Error(copy.historyProviderUnavailable);
      }
      const images = imported.accepted.map((image, index) => ({
        ...image,
        id: orderedItems[index].id,
      }));
      const jobs = Object.fromEntries(orderedItems.map((item) => [
        item.id,
        item.status === 'done'
          ? {
              status: 'done' as const,
              progress: {
                stage: 'done' as const,
                operation: 'restore-history',
                detail: copy.historyRecoveryLoadedDetail,
              },
            }
          : {
              status: item.status === 'running' ? 'queued' as const : item.status,
              error: item.error,
            },
      ]));
      host.installRecovery({
        batch: preparation.batch,
        images,
        jobs,
        settings,
      });
    },
    async installDraft(preparation) {
      const imported = await importer.importFiles(preparation.files, []);
      if (imported.accepted.length !== preparation.files.length) {
        releaseImportedImages(imported.accepted);
        throw new Error(copy.historyOriginalValidationFailed);
      }
      const draft = createWebSettingsDraftFromLockedConfig(
        preparation.sourceBatch.lockedConfig,
        host.currentSettings(),
      );
      host.installDraft({
        images: imported.accepted,
        settings: draft.settings,
        providerSelectionRequired: draft.providerSelectionRequired,
      });
    },
    discardRecovery: (batchId) => host.discardRecovery(batchId),
  };
}
