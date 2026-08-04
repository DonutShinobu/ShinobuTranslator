import {
  createRedactedDiagnostics,
  downloadRedactedDiagnostics,
  type RedactedDiagnosticInput,
} from '../diagnostics/redactedDiagnostics';
import type {
  WebWorkbenchDiagnosticsAdapter,
} from './webWorkbench';

type BrowserWorkbenchDiagnosticsOptions = {
  versions: RedactedDiagnosticInput['versions'];
  device: RedactedDiagnosticInput['device'];
  lifecycle(): RedactedDiagnosticInput['lifecycle'];
};

export function createBrowserWorkbenchDiagnostics({
  versions,
  device,
  lifecycle,
}: BrowserWorkbenchDiagnosticsOptions): WebWorkbenchDiagnosticsAdapter {
  return {
    async export(source) {
      const storage = await navigator.storage?.estimate?.().catch(() => undefined);
      const providerId = source.settings.translationProviderId;
      const diagnostics = createRedactedDiagnostics({
        locale: source.settings.uiLocale,
        userAgent: navigator.userAgent,
        versions,
        device,
        capability: source.runtime.capability ?? null,
        modelPackage: source.runtime.modelPackage,
        jobs: source.jobs,
        provider: {
          id: providerId,
          baseUrl: source.settings.providerProfiles[providerId].baseUrl,
          configurationValid: source.providerConfigurationValid,
        },
        lifecycle: lifecycle(),
        storage,
      });
      downloadRedactedDiagnostics(
        diagnostics,
        `shinobu-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      );
    },
  };
}
