import { detectWebDeviceProfile } from '../../runtime/deviceProfile';
import {
  ensureModelStorageCapacity,
  inspectModelPackage,
  installModelPackage,
} from '../../runtime/modelInstaller';
import { WEB_MODEL_PACKAGE } from '../../runtime/modelPackage';
import { OpfsModelPackageStore } from '../../runtime/modelPackageStore';
import { probeInstalledProductionModels } from '../../runtime/modelCapability';
import { probeWebRuntimeCapability } from '../../runtime/capability';
import { createWebTranslatorCore } from '../../runtime/webPipeline';
import { inspectWebStorage } from '../storage/storageBudget';
import {
  createProcessingRuntime,
  type ProcessingRuntime,
  type ProcessingRuntimeEnvironment,
} from './processingRuntime';

export const MODEL_DOWNLOAD_CONSENT_STORAGE_KEY =
  'shinobu:model-download-consent:v1';

function browserEnvironment(): ProcessingRuntimeEnvironment {
  const snapshot = () => ({
    online: navigator.onLine,
    visibility: document.visibilityState === 'hidden' ? 'hidden' as const : 'visible' as const,
  });
  return {
    snapshot,
    subscribe(listener) {
      const notify = (): void => listener(snapshot());
      window.addEventListener('online', notify);
      window.addEventListener('offline', notify);
      document.addEventListener('visibilitychange', notify);
      return () => {
        window.removeEventListener('online', notify);
        window.removeEventListener('offline', notify);
        document.removeEventListener('visibilitychange', notify);
      };
    },
  };
}

function readModelConsent(): boolean {
  try {
    return localStorage.getItem(MODEL_DOWNLOAD_CONSENT_STORAGE_KEY) === 'accepted';
  } catch {
    return false;
  }
}

function writeModelConsent(accepted: boolean): void {
  try {
    if (accepted) {
      localStorage.setItem(MODEL_DOWNLOAD_CONSENT_STORAGE_KEY, 'accepted');
    } else {
      localStorage.removeItem(MODEL_DOWNLOAD_CONSENT_STORAGE_KEY);
    }
  } catch {
    // Consent remains valid for the current page when localStorage is unavailable.
  }
}

export function createBrowserProcessingRuntime(): ProcessingRuntime {
  const store = new OpfsModelPackageStore();
  const device = detectWebDeviceProfile();
  return createProcessingRuntime({
    environment: browserEnvironment(),
    readModelConsent,
    writeModelConsent,
    inspectModelPackage: () => inspectModelPackage(store, WEB_MODEL_PACKAGE),
    async installModelPackage({ signal, onProgress }) {
      const before = await inspectModelPackage(store, WEB_MODEL_PACKAGE);
      if (before.installed) return;
      if (before.storedBytes === 0) await ensureModelStorageCapacity();
      await installModelPackage({
        manifest: WEB_MODEL_PACKAGE,
        store,
        signal,
        onProgress,
      });
    },
    probeCapability: ({ useCache }) =>
      probeWebRuntimeCapability(WEB_MODEL_PACKAGE.version, { useCache }),
    probeModels: ({
      backend,
      signal,
      useCache,
      onProgress,
    }) => probeInstalledProductionModels({
      backend,
      signal,
      useCache,
      onProgress,
    }),
    inspectStorage: inspectWebStorage,
    createCore: createWebTranslatorCore,
    fallbackWorkPixelBudget: device.mobile ? 4_000_000 : 6_000_000,
  });
}
