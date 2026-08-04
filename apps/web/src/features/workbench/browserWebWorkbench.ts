import type { WebSettings } from '@shinobu/shared-config';

import { createBrowserLocalHistoryEnvironment } from '../history/browserLocalHistoryLifecycle';
import type { LocalHistoryVersions } from '../history/localHistory';
import type { ImageImporter } from '../import/imageImporter';
import { createProcessingBatchWorkspace } from '../processing/processingBatch';
import { createBrowserProcessingRuntime } from '../processing/browserProcessingRuntime';
import {
  createWebWorkbench,
  type WebWorkbench,
  type WebWorkbenchCredentialAdapter,
  type WebWorkbenchDiagnosticsAdapter,
} from './webWorkbench';

type CreateBrowserWebWorkbenchOptions = {
  initialSettings: WebSettings;
  importer(): ImageImporter;
  credentials: WebWorkbenchCredentialAdapter;
  diagnostics: WebWorkbenchDiagnosticsAdapter;
  versions: LocalHistoryVersions;
  onSettingsChanged?(next: WebSettings, previous: WebSettings): void;
  onProcessingCompleted?(): void;
};

export function createBrowserWebWorkbench({
  initialSettings,
  importer,
  credentials,
  diagnostics,
  versions,
  onSettingsChanged,
  onProcessingCompleted,
}: CreateBrowserWebWorkbenchOptions): WebWorkbench {
  return createWebWorkbench({
    initialSettings,
    importer,
    credentials,
    diagnostics,
    versions,
    createRuntime(adapter) {
      const processingRuntime = createBrowserProcessingRuntime();
      const history = createBrowserLocalHistoryEnvironment(adapter);
      return {
        lifecycle: history.lifecycle,
        processingRuntime,
        processing: createProcessingBatchWorkspace({
          history: history.history,
          coordinator: history.coordinator,
          runtime: processingRuntime,
          async readThumbnail(image) {
            try {
              const response = await fetch(image.thumbnailUrl);
              return response.ok ? await response.blob() : undefined;
            } catch {
              return undefined;
            }
          },
        }),
        dispose: () => history.dispose(),
      };
    },
    onSettingsChanged,
    onProcessingCompleted,
  });
}
