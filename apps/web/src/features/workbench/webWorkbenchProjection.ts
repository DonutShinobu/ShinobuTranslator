import {
  normalizeProviderTargetBinding,
  validateProviderBaseUrl,
} from '@shinobu/shared-config';
import type { ProcessingBatchSnapshot } from '../processing/processingBatch';
import type {
  HistoryAvailability,
  LocalHistorySnapshot,
} from '../history/localHistoryLifecycle';
import type {
  ProcessingRuntimeDecision,
  ProcessingRuntimeCredentialStatus,
  ProcessingRuntimeSnapshot,
} from '../processing/processingRuntime';
import { assessImageImportStorage } from '../storage/storageBudget';
import type {
  WebWorkbenchAvailability,
  WebWorkbenchCameraEntryAction,
  WebWorkbenchControls,
  WebWorkbenchHistoryAvailability,
  WebWorkbenchHistoryView,
  WebWorkbenchItemActions,
  WebWorkbenchPrimaryAction,
  WebWorkbenchProcessingView,
  WebWorkbenchProviderView,
  WebWorkbenchRuntimeView,
  WebWorkbenchSnapshot,
} from './webWorkbench';

function projectHistoryAvailability(
  availability: HistoryAvailability,
): WebWorkbenchHistoryAvailability {
  return availability.allowed
    ? { status: 'available' }
    : { status: 'blocked', reason: availability.code };
}

export function projectWebWorkbenchHistory(
  snapshot: LocalHistorySnapshot,
): WebWorkbenchHistoryView {
  return {
    status: snapshot.status,
    busy: snapshot.busy,
    entries: snapshot.entries.map(({ batch, completedCount, eligibility, integrity }) => ({
      id: batch.id,
      updatedAt: batch.updatedAt,
      status: batch.status,
      rerunnable: batch.rerunnable,
      itemCount: batch.items.length,
      completedCount,
      integrity,
      processing: {
        processMode: batch.lockedConfig.processMode,
        targetLanguage: batch.lockedConfig.targetLanguage,
        providerId: batch.lockedConfig.provider.id,
        modelVersion: batch.versions.model,
      },
      items: batch.items.map((item) => ({
        id: item.id,
        order: item.order,
        width: item.width,
        height: item.height,
        status: item.status,
        fileName: item.original?.fileName,
        error: item.error,
        hasResult: Boolean(item.result),
      })),
      actions: {
        resume: projectHistoryAvailability(eligibility.resume),
        clone: projectHistoryAvailability(eligibility.clone),
        exportResults: projectHistoryAvailability(eligibility.exportResults),
        exportProject: projectHistoryAvailability(eligibility.exportProject),
        keepResultsOnly: projectHistoryAvailability(eligibility.keepResultsOnly),
        delete: projectHistoryAvailability(eligibility.delete),
      },
    })),
    cleanup: {
      faultCount: snapshot.faults.length,
      unreleasedBytes: snapshot.faults.reduce(
        (total, fault) => total + fault.unreleasedBytes,
        0,
      ),
    },
    pending: snapshot.pending,
    failure: snapshot.failure,
  };
}

type WebWorkbenchProjectionInput = {
  snapshot: WebWorkbenchSnapshot;
  runtime?: ProcessingRuntimeSnapshot;
  decisions: Partial<Record<'queue' | 'camera', ProcessingRuntimeDecision>>;
  batch?: ProcessingBatchSnapshot;
  credential: ProcessingRuntimeCredentialStatus;
};

function availabilityFor(
  decision: ProcessingRuntimeDecision | undefined,
): WebWorkbenchAvailability {
  return decision?.status === 'ready'
    ? { status: 'available' }
    : {
        status: 'blocked',
        reason: decision?.code ?? 'CAPABILITY_CHECKING',
        detail: decision?.detail,
        requiredBytes: decision?.requiredBytes,
        availableBytes: decision?.availableBytes,
      };
}

function projectRuntime(
  runtime: ProcessingRuntimeSnapshot | undefined,
  decisions: WebWorkbenchProjectionInput['decisions'],
): WebWorkbenchRuntimeView {
  return {
    status: runtime?.status ?? 'checking',
    environment: runtime?.environment ?? { online: true, visibility: 'visible' },
    capability: runtime?.capability,
    modelConsent: runtime?.modelConsent ?? false,
    modelPackage: runtime?.modelPackage
      ?? { status: 'checking', storedBytes: 0, totalBytes: 0 },
    modelProbe: runtime?.modelProbe ?? { status: 'pending' },
    storage: runtime?.storage ?? { status: 'checking' },
    queue: availabilityFor(decisions.queue),
    camera: availabilityFor(decisions.camera),
  };
}

function projectProvider(
  snapshot: WebWorkbenchSnapshot,
  credential: ProcessingRuntimeCredentialStatus,
): WebWorkbenchProviderView {
  if (snapshot.settings.processMode !== 'translate') {
    return { configuration: { status: 'available' } };
  }
  const providerId = snapshot.settings.translationProviderId;
  const profile = snapshot.settings.providerProfiles[providerId];
  const targetError = validateProviderBaseUrl(profile.baseUrl);
  if (targetError) {
    return {
      configuration: {
        status: 'blocked',
        reason: 'PROVIDER_INVALID',
        detail: targetError,
      },
    };
  }
  if (!profile.model.trim()) {
    return { configuration: { status: 'blocked', reason: 'MODEL_MISSING' } };
  }
  if (!credential.available) {
    return { configuration: { status: 'blocked', reason: 'CREDENTIAL_MISSING' } };
  }
  try {
    if (
      credential.providerId !== providerId
      || normalizeProviderTargetBinding(credential.target)
        !== normalizeProviderTargetBinding(profile.baseUrl)
    ) {
      return {
        configuration: { status: 'blocked', reason: 'CREDENTIAL_TARGET_MISMATCH' },
      };
    }
  } catch {
    return { configuration: { status: 'blocked', reason: 'PROVIDER_INVALID' } };
  }
  return { configuration: { status: 'available' } };
}

function projectProcessing(
  batch: ProcessingBatchSnapshot | undefined,
): WebWorkbenchProcessingView {
  return {
    status: batch?.status ?? 'idle',
    canStop: batch?.status === 'running',
    canCancelCurrent: batch?.status === 'running' && Boolean(batch.currentTaskId),
    canRetryTasks: Boolean(batch),
  };
}

function projectControls(
  snapshot: WebWorkbenchSnapshot,
  processingActive: boolean,
): WebWorkbenchControls {
  const recoveryActive = snapshot.phase === 'recovery';
  const storage = snapshot.runtime.storage;
  const storageAdmission = storage.status === 'checking'
    ? { allowed: false as const, reason: 'checking' as const }
    : assessImageImportStorage(storage, 0);
  const importImages: WebWorkbenchAvailability = snapshot.importing
    ? { status: 'blocked', reason: 'IMPORTING' }
    : recoveryActive
      ? { status: 'blocked', reason: 'RECOVERY_ACTIVE' }
      : !storageAdmission.allowed
        ? {
            status: 'blocked',
            reason: storageAdmission.reason === 'checking'
              ? 'STORAGE_CHECKING'
              : storageAdmission.reason === 'unavailable'
                ? 'STORAGE_UNAVAILABLE'
                : 'INSUFFICIENT_STORAGE',
            requiredBytes: 'requiredBytes' in storageAdmission
              ? storageAdmission.requiredBytes
              : undefined,
            availableBytes: 'availableBytes' in storageAdmission
              ? storageAdmission.availableBytes
              : undefined,
          }
        : { status: 'available' };
  return {
    importImages,
    editProcessingSettings: processingActive
      ? { status: 'blocked', reason: 'PROCESSING_ACTIVE' }
      : recoveryActive
        ? { status: 'blocked', reason: 'RECOVERY_ACTIVE' }
        : { status: 'available' },
    openCamera: snapshot.phase !== 'empty'
      ? { status: 'blocked', reason: 'WORKBENCH_OCCUPIED' }
      : snapshot.importing
        ? { status: 'blocked', reason: 'IMPORTING' }
        : snapshot.runtime.camera,
    exitRecovery: recoveryActive && !processingActive
      ? { status: 'available' }
      : { status: 'blocked', reason: recoveryActive ? 'PROCESSING_ACTIVE' : 'NO_RECOVERY' },
  };
}

function projectCameraEntry(
  snapshot: WebWorkbenchSnapshot,
): WebWorkbenchCameraEntryAction {
  const availability = snapshot.controls.openCamera;
  if (availability.status === 'available') {
    if (snapshot.provider.configuration.status === 'blocked') {
      return { kind: 'open-provider-settings', availability: { status: 'available' } };
    }
    return { kind: 'open-camera', availability: { status: 'available' } };
  }
  if (
    availability.reason === 'STORAGE_UNAVAILABLE'
    || availability.reason === 'INSUFFICIENT_STORAGE'
  ) {
    return { kind: 'open-storage-settings', availability: { status: 'available' } };
  }
  if (
    availability.reason === 'PROVIDER_INVALID'
    || availability.reason === 'CREDENTIAL_MISSING'
    || availability.reason === 'CREDENTIAL_TARGET_MISMATCH'
  ) {
    return { kind: 'open-provider-settings', availability: { status: 'available' } };
  }
  return { kind: 'unavailable', availability };
}

function projectItemActions(
  snapshot: WebWorkbenchSnapshot,
  processingActive: boolean,
): WebWorkbenchSnapshot['itemActions'] {
  return Object.fromEntries(snapshot.images.map((image, index) => {
    const job = snapshot.jobs[image.id];
    const editBlocker = snapshot.importing
      ? 'IMPORTING'
      : snapshot.phase === 'recovery'
        ? 'RECOVERY_ACTIVE'
        : job?.status === 'running'
          ? 'TASK_RUNNING'
          : processingActive && job?.status !== 'queued'
            ? 'BATCH_ITEM_LOCKED'
            : undefined;
    const editable: WebWorkbenchAvailability = editBlocker
      ? { status: 'blocked', reason: editBlocker }
      : { status: 'available' };
    const movementAvailability = (targetIndex: number): WebWorkbenchAvailability => {
      if (targetIndex < 0) return { status: 'blocked', reason: 'FIRST_ITEM' };
      if (targetIndex >= snapshot.images.length) {
        return { status: 'blocked', reason: 'LAST_ITEM' };
      }
      if (editable.status === 'blocked') return editable;
      const targetJob = snapshot.jobs[snapshot.images[targetIndex].id];
      return processingActive && targetJob?.status !== 'queued'
        ? { status: 'blocked', reason: 'BATCH_ITEM_LOCKED' }
        : { status: 'available' };
    };
    return [image.id, {
      remove: editable,
      moveUp: movementAvailability(index - 1),
      moveDown: movementAvailability(index + 1),
      retry: processingActive && (job?.status === 'failed' || job?.status === 'cancelled')
        ? { status: 'available' }
        : { status: 'blocked', reason: 'TASK_NOT_RETRYABLE' },
    } satisfies WebWorkbenchItemActions];
  }));
}

function projectPrimaryAction(snapshot: WebWorkbenchSnapshot): WebWorkbenchPrimaryAction {
  if (snapshot.processing.status === 'running') {
    return { kind: 'stop-processing', availability: { status: 'available' } };
  }
  if (snapshot.images.length === 0) {
    const availability = snapshot.controls.importImages;
    if (
      availability.status === 'blocked'
      && (availability.reason === 'STORAGE_UNAVAILABLE'
        || availability.reason === 'INSUFFICIENT_STORAGE')
    ) {
      return { kind: 'open-storage-settings', availability: { status: 'available' } };
    }
    return { kind: 'pick-images', availability };
  }
  if (snapshot.importing) {
    return {
      kind: 'start-processing',
      availability: { status: 'blocked', reason: 'IMPORTING' },
    };
  }
  if (snapshot.draftProviderSelectionRequired) {
    return { kind: 'open-provider-settings', availability: { status: 'available' } };
  }
  const availability = snapshot.runtime.queue;
  if (availability.status === 'available') {
    return { kind: 'start-processing', availability: { status: 'available' } };
  }
  if (availability.reason === 'STORAGE_UNAVAILABLE' || availability.reason === 'INSUFFICIENT_STORAGE') {
    return { kind: 'open-storage-settings', availability: { status: 'available' } };
  }
  if (
    availability.reason === 'MODEL_CONSENT_REQUIRED'
    || availability.reason === 'MODEL_PACKAGE_MISSING'
    || availability.reason === 'MODEL_INSTALL_PAUSED'
    || availability.reason === 'MODEL_INSTALL_FAILED'
  ) {
    return { kind: 'install-models', availability: { status: 'available' } };
  }
  if (availability.reason === 'MODEL_PROBE_FAILED' || availability.reason === 'CAPABILITY_FAILED') {
    return { kind: 'retry-runtime', availability: { status: 'available' } };
  }
  if (
    availability.reason === 'PROVIDER_INVALID'
    || availability.reason === 'CREDENTIAL_MISSING'
    || availability.reason === 'CREDENTIAL_TARGET_MISMATCH'
  ) {
    return { kind: 'open-provider-settings', availability: { status: 'available' } };
  }
  return { kind: 'start-processing', availability };
}

export function projectWebWorkbench(input: WebWorkbenchProjectionInput): WebWorkbenchSnapshot {
  const next: WebWorkbenchSnapshot = {
    ...input.snapshot,
    runtime: projectRuntime(input.runtime, input.decisions),
    processing: projectProcessing(input.batch),
    provider: projectProvider(input.snapshot, input.credential),
  };
  const processingActive = input.batch !== undefined;
  next.controls = projectControls(next, processingActive);
  next.itemActions = projectItemActions(next, processingActive);
  next.primaryAction = projectPrimaryAction(next);
  next.camera = { ...next.camera, entry: projectCameraEntry(next) };
  return next;
}
