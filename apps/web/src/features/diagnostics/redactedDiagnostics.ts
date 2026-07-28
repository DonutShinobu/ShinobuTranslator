import type { TranslationProviderId, UiLocale } from '@shinobu/shared-config';
import { isLocalPipelineErrorCode } from '../../../../../src/shared/localPipelineProtocol';
import type { PipelineProgress } from '../../../../../src/types';
import type { ModelPackageState } from '../models/useModelPackage';
import type { WebRuntimeCapability } from '../../runtime/capability';
import type { WebDeviceProfile } from '../../runtime/deviceProfile';

type DiagnosticJob = {
  status: string;
  progress?: Pick<PipelineProgress, 'stage'>;
  errorCode?: string;
};

type StorageSnapshot = {
  usage?: number;
  quota?: number;
};

export type RedactedDiagnosticInput = {
  generatedAt?: string;
  locale: UiLocale;
  userAgent: string;
  versions: {
    app: string;
    core: string;
    model: string;
    configSchema: number;
  };
  device: WebDeviceProfile;
  capability: WebRuntimeCapability | null;
  modelPackage: ModelPackageState;
  jobs: readonly DiagnosticJob[];
  provider: {
    id: TranslationProviderId;
    baseUrl: string;
    configurationValid: boolean;
  };
  lifecycle: {
    online: boolean;
    offlineReady: boolean;
    updateReady: boolean;
    visibilityState: DocumentVisibilityState;
  };
  storage?: StorageSnapshot;
};

export const REDACTED_DIAGNOSTIC_SCHEMA_VERSION = 2 as const;

function countValues(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return 'invalid-provider-url';
  }
}

function safeErrorCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return isLocalPipelineErrorCode(value) ? value : 'UNCLASSIFIED';
}

export function createRedactedDiagnostics(input: RedactedDiagnosticInput): object {
  const progress = input.modelPackage.progress;
  const errorCodes = input.jobs
    .map((job) => safeErrorCode(job.errorCode))
    .filter((value): value is string => Boolean(value));
  return {
    schemaVersion: REDACTED_DIAGNOSTIC_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    versions: { ...input.versions },
    locale: input.locale,
    userAgent: input.userAgent,
    device: { ...input.device },
    capability: input.capability
      ? {
        ok: input.capability.ok,
        supportLevel: input.capability.supportLevel,
        backend: input.capability.backend,
        workPixelBudget: input.capability.workPixelBudget,
        storagePersistent: input.capability.storagePersistent,
        wasmThreads: input.capability.wasmThreads,
        webgpu: input.capability.webgpu,
      }
      : null,
    modelPackage: {
      status: input.modelPackage.status,
      storedBytes: input.modelPackage.storedBytes,
      totalBytes: input.modelPackage.totalBytes,
      progress: progress
        ? {
          phase: progress.phase,
          assetIndex: progress.assetIndex,
          assetCount: progress.assetCount,
          downloadedBytes: progress.downloadedBytes,
          totalBytes: progress.totalBytes,
        }
        : null,
    },
    taskSummary: {
      total: input.jobs.length,
      statuses: countValues(input.jobs.map((job) => job.status)),
      activeStages: countValues(
        input.jobs
          .map((job) => job.progress?.stage)
          .filter((value): value is string => Boolean(value)),
      ),
      errorCodes: countValues(errorCodes),
    },
    provider: {
      id: input.provider.id,
      host: providerHost(input.provider.baseUrl),
      configurationValid: input.provider.configurationValid,
    },
    lifecycle: { ...input.lifecycle },
    storage: {
      usageBytes: input.storage?.usage ?? null,
      quotaBytes: input.storage?.quota ?? null,
    },
  };
}

export function downloadRedactedDiagnostics(diagnostics: object, fileName: string): void {
  const blob = new Blob(
    [JSON.stringify(diagnostics, null, 2)],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}
