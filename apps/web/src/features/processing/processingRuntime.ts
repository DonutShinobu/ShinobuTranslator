import {
  normalizeProviderTargetBinding,
  validateProviderBaseUrl,
  type TranslationProviderId,
  type WebSettings,
} from '@shinobu/shared-config';
import type { PipelineProgress } from '@shinobu/image-pipeline';
import type { TranslationTask } from '@shinobu/translator-core';
import {
  assessImageImportStorage,
  type WebStorageSnapshot,
} from '../storage/storageBudget';
import type {
  ModelInstallProgress,
  ModelPackageInspection,
} from '../../runtime/modelInstaller';
import type {
  ModelCapabilityProgress,
  ModelCapabilityResult,
} from '../../runtime/modelCapability';
import type { WebRuntimeCapability } from '../../runtime/capability';
import {
  type WebPipelineInput,
  type WebPipelineResult,
  type WebPipelineRuntimeCapabilities,
  type WebTranslatorCore,
} from '../../runtime/webPipeline';
import { toWebPipelineConfig } from '../../runtime/webPipelineConfig';

export type ProcessingRuntimeCredential = {
  providerId: TranslationProviderId;
  target: string;
  value: string;
};

export type ProcessingRuntimeCredentialStatus = {
  providerId: TranslationProviderId;
  target: string;
  available: boolean;
};

export type ProcessingRuntimeAssessmentRequest = {
  settings: WebSettings;
  credential: ProcessingRuntimeCredentialStatus;
  pendingOriginalBytes: number;
};

export type ProcessingRuntimeRequest = {
  settings: WebSettings;
  credential: ProcessingRuntimeCredential;
  pendingOriginalBytes: number;
};

export type ProcessingRuntimeEnvironmentSnapshot = {
  online: boolean;
  visibility: 'visible' | 'hidden';
};

export type ProcessingRuntimeEnvironment = {
  snapshot(): ProcessingRuntimeEnvironmentSnapshot;
  subscribe(
    listener: (snapshot: ProcessingRuntimeEnvironmentSnapshot) => void,
  ): () => void;
};

export type ProcessingRuntimeModelPackageState = {
  status: 'checking' | 'missing' | 'installing' | 'paused' | 'failed' | 'installed';
  progress?: ModelInstallProgress;
  storedBytes: number;
  totalBytes: number;
  error?: string;
};

export type ProcessingRuntimeModelProbeState =
  | { status: 'pending' }
  | {
      status: 'checking';
      progress?: ModelCapabilityProgress;
      provider?: 'webgpu' | 'wasm';
    }
  | {
      status: 'ready';
      provider: 'webgpu' | 'wasm';
    }
  | {
      status: 'failed';
      error: string;
    };

export type ProcessingRuntimeStorageState =
  | { status: 'checking' }
  | WebStorageSnapshot;

export type ProcessingRuntimeSnapshot = {
  status: 'checking' | 'ready' | 'blocked' | 'installing' | 'suspended' | 'disposed';
  environment: ProcessingRuntimeEnvironmentSnapshot;
  modelConsent: boolean;
  capability?: WebRuntimeCapability;
  modelPackage: ProcessingRuntimeModelPackageState;
  modelProbe: ProcessingRuntimeModelProbeState;
  storage: ProcessingRuntimeStorageState;
};

export type ProcessingRuntimeBlockerCode =
  | 'RUNTIME_DISPOSED'
  | 'PAGE_HIDDEN'
  | 'OFFLINE'
  | 'CAPABILITY_CHECKING'
  | 'CAPABILITY_FAILED'
  | 'MODEL_PACKAGE_CHECKING'
  | 'MODEL_CONSENT_REQUIRED'
  | 'MODEL_PACKAGE_MISSING'
  | 'MODEL_INSTALLING'
  | 'MODEL_INSTALL_PAUSED'
  | 'MODEL_INSTALL_FAILED'
  | 'MODEL_PROBING'
  | 'MODEL_PROBE_FAILED'
  | 'PROVIDER_INVALID'
  | 'CREDENTIAL_MISSING'
  | 'CREDENTIAL_TARGET_MISMATCH'
  | 'STORAGE_CHECKING'
  | 'STORAGE_UNAVAILABLE'
  | 'INSUFFICIENT_STORAGE';

export type ProcessingRuntimeDecision =
  | {
      status: 'ready';
      backend: 'webgpu' | 'wasm';
      workPixelBudget: number;
    }
  | {
      status: 'blocked';
      code: ProcessingRuntimeBlockerCode;
      detail?: string;
      requiredBytes?: number;
      availableBytes?: number;
    };

export type ProcessingRuntimeCommand =
  | { type: 'refresh' }
  | { type: 'refresh-storage' }
  | { type: 'accept-model-download' }
  | { type: 'cancel-model-download' }
  | { type: 'retry' }
  | { type: 'dispose' };

export interface ProcessingRuntimeLease {
  run(
    input: WebPipelineInput,
  ): TranslationTask<PipelineProgress, WebPipelineResult>;
  admit(pendingOriginalBytes: number): Promise<void>;
  release(): void;
}

export interface ProcessingRuntime {
  snapshot(): ProcessingRuntimeSnapshot;
  subscribe(listener: (snapshot: ProcessingRuntimeSnapshot) => void): () => void;
  assess(request: ProcessingRuntimeAssessmentRequest): ProcessingRuntimeDecision;
  prepare(request: ProcessingRuntimeRequest): Promise<ProcessingRuntimeLease>;
  dispatch(command: ProcessingRuntimeCommand): Promise<void>;
}

export type ProcessingRuntimeDependencies = {
  environment: ProcessingRuntimeEnvironment;
  readModelConsent(): boolean;
  writeModelConsent(accepted: boolean): void;
  inspectModelPackage(): Promise<ModelPackageInspection>;
  installModelPackage(options: {
    signal: AbortSignal;
    onProgress(progress: ModelInstallProgress): void;
  }): Promise<void>;
  probeCapability(options: { useCache: boolean }): Promise<WebRuntimeCapability>;
  probeModels(options: {
    backend: 'webgpu' | 'wasm';
    signal: AbortSignal;
    useCache: boolean;
    onProgress(progress: ModelCapabilityProgress): void;
  }): Promise<ModelCapabilityResult>;
  inspectStorage(): Promise<WebStorageSnapshot>;
  createCore(capabilities?: WebPipelineRuntimeCapabilities): WebTranslatorCore;
  fallbackWorkPixelBudget: number;
};

export class ProcessingRuntimeBlockedError extends Error {
  constructor(readonly decision: Extract<ProcessingRuntimeDecision, { status: 'blocked' }>) {
    super(decision.detail ?? decision.code);
    this.name = 'ProcessingRuntimeBlockedError';
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ProcessingRuntimeImplementation implements ProcessingRuntime {
  private readonly listeners = new Set<(snapshot: ProcessingRuntimeSnapshot) => void>();
  private environment: ProcessingRuntimeEnvironmentSnapshot;
  private modelConsent: boolean;
  private capability: WebRuntimeCapability | undefined;
  private capabilityError: string | undefined;
  private modelPackage: ProcessingRuntimeModelPackageState = {
    status: 'checking',
    storedBytes: 0,
    totalBytes: 0,
  };
  private modelProbe: ProcessingRuntimeModelProbeState = { status: 'pending' };
  private storage: ProcessingRuntimeStorageState = { status: 'checking' };
  private core: WebTranslatorCore | undefined;
  private coreCredential: string | undefined;
  private coreDisposal = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private commandTail = Promise.resolve();
  private installController: AbortController | undefined;
  private installAbortOutcome: 'cancelled' | 'paused' | undefined;
  private probeController: AbortController | undefined;
  private readonly unsubscribeEnvironment: () => void;

  constructor(private readonly dependencies: ProcessingRuntimeDependencies) {
    this.environment = dependencies.environment.snapshot();
    this.modelConsent = dependencies.readModelConsent();
    this.unsubscribeEnvironment = dependencies.environment.subscribe((snapshot) => {
      const previous = this.environment;
      this.environment = snapshot;
      if (snapshot.visibility === 'hidden' || !snapshot.online) {
        const reason = new DOMException(
          snapshot.visibility === 'hidden'
            ? '页面进入后台，处理运行时已暂停'
            : '网络已断开，处理运行时已暂停',
          'AbortError',
        );
        this.probeController?.abort(reason);
        this.probeController = undefined;
        if (this.installController && !this.installController.signal.aborted) {
          this.installAbortOutcome = 'paused';
          this.installController.abort(reason);
          this.modelPackage = {
            ...this.modelPackage,
            status: 'paused',
            error: undefined,
          };
        }
        this.capability = undefined;
        this.modelProbe = { status: 'pending' };
        this.invalidateCore(reason);
      } else if (
        previous.visibility === 'hidden'
        || !previous.online
      ) {
        void this.dispatch({ type: 'refresh' });
      }
      this.emit();
    });
  }

  snapshot(): ProcessingRuntimeSnapshot {
    return {
      status: this.status(),
      environment: { ...this.environment },
      modelConsent: this.modelConsent,
      capability: this.capability ? { ...this.capability } : undefined,
      modelPackage: {
        ...this.modelPackage,
        progress: this.modelPackage.progress
          ? { ...this.modelPackage.progress }
          : undefined,
      },
      modelProbe: this.modelProbe.status === 'checking'
        ? {
            ...this.modelProbe,
            progress: this.modelProbe.progress
              ? { ...this.modelProbe.progress }
              : undefined,
          }
        : { ...this.modelProbe },
      storage: { ...this.storage },
    };
  }

  subscribe(listener: (snapshot: ProcessingRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  assess(request: ProcessingRuntimeAssessmentRequest): ProcessingRuntimeDecision {
    const base = this.baseDecision();
    if (base) return base;

    if (request.settings.processMode === 'translate') {
      const profile = request.settings.providerProfiles[
        request.settings.translationProviderId
      ];
      const providerError = validateProviderBaseUrl(profile.baseUrl)
        || (!profile.model.trim() ? '翻译模型不能为空' : null);
      if (providerError) {
        return {
          status: 'blocked',
          code: 'PROVIDER_INVALID',
          detail: providerError,
        };
      }
      if (!request.credential.available) {
        return {
          status: 'blocked',
          code: 'CREDENTIAL_MISSING',
        };
      }
      try {
        if (
          request.credential.providerId !== request.settings.translationProviderId
          || normalizeProviderTargetBinding(request.credential.target)
            !== normalizeProviderTargetBinding(profile.baseUrl)
        ) {
          return {
            status: 'blocked',
            code: 'CREDENTIAL_TARGET_MISMATCH',
          };
        }
      } catch (error) {
        return {
          status: 'blocked',
          code: 'PROVIDER_INVALID',
          detail: messageFor(error),
        };
      }
    }

    if (this.storage.status === 'checking') {
      return {
        status: 'blocked',
        code: 'STORAGE_CHECKING',
      };
    }
    const storage = assessImageImportStorage(
      this.storage,
      request.pendingOriginalBytes,
    );
    if (!storage.allowed) {
      return storage.reason === 'unavailable'
        ? {
            status: 'blocked',
            code: 'STORAGE_UNAVAILABLE',
            requiredBytes: storage.requiredBytes,
          }
        : {
            status: 'blocked',
            code: 'INSUFFICIENT_STORAGE',
            requiredBytes: storage.requiredBytes,
            availableBytes: storage.availableBytes,
          };
    }

    const capability = this.capability!;
    const provider = this.modelProbe.status === 'ready'
      ? this.modelProbe.provider
      : capability.backend;
    return {
      status: 'ready',
      backend: provider,
      workPixelBudget: provider === 'wasm'
        ? Math.min(
            capability.workPixelBudget,
            this.dependencies.fallbackWorkPixelBudget,
          )
        : capability.workPixelBudget,
    };
  }

  async prepare(request: ProcessingRuntimeRequest): Promise<ProcessingRuntimeLease> {
    this.assertNotDisposed();
    this.storage = await this.inspectStorageSafely();
    this.emit();
    const decision = this.assess({
      settings: request.settings,
      credential: {
        providerId: request.credential.providerId,
        target: request.credential.target,
        available: Boolean(request.credential.value.trim()),
      },
      pendingOriginalBytes: request.pendingOriginalBytes,
    });
    if (decision.status === 'blocked') {
      throw new ProcessingRuntimeBlockedError(decision);
    }
    const generation = this.generation;
    const config = toWebPipelineConfig(structuredClone(request.settings));
    const credential = request.credential.value;
    let released = false;
    const assertActive = (): void => {
      if (released || this.disposed || generation !== this.generation) {
        throw new ProcessingRuntimeBlockedError({
          status: 'blocked',
          code: this.disposed ? 'RUNTIME_DISPOSED' : 'CAPABILITY_CHECKING',
          detail: '处理运行时 lease 已失效',
        });
      }
    };
    return {
      run: (input) => {
        assertActive();
        if (!this.core || this.coreCredential !== credential) {
          const staleCore = this.core;
          if (staleCore) this.enqueueCoreDisposal(staleCore, new DOMException(
            '文本翻译 runtime capability 已改变',
            'AbortError',
          ));
          this.core = this.dependencies.createCore({
            textTranslation: { apiKey: credential },
          });
          this.coreCredential = credential;
        }
        const core = this.core;
        return core.run({ input, config });
      },
      admit: async (pendingOriginalBytes) => {
        assertActive();
        this.storage = await this.inspectStorageSafely();
        this.emit();
        const storage = assessImageImportStorage(this.storage, pendingOriginalBytes);
        if (!storage.allowed) {
          throw new ProcessingRuntimeBlockedError(storage.reason === 'unavailable'
            ? {
                status: 'blocked',
                code: 'STORAGE_UNAVAILABLE',
                requiredBytes: storage.requiredBytes,
              }
            : {
                status: 'blocked',
                code: 'INSUFFICIENT_STORAGE',
                requiredBytes: storage.requiredBytes,
                availableBytes: storage.availableBytes,
              });
        }
      },
      release: () => {
        released = true;
      },
    };
  }

  dispatch(command: ProcessingRuntimeCommand): Promise<void> {
    if (command.type === 'cancel-model-download') {
      if (this.disposed) {
        return Promise.reject(new ProcessingRuntimeBlockedError({
          status: 'blocked',
          code: 'RUNTIME_DISPOSED',
        }));
      }
      if (this.installController && !this.installController.signal.aborted) {
        this.installAbortOutcome = 'cancelled';
        this.installController.abort(new DOMException('模型下载已取消', 'AbortError'));
      }
      return Promise.resolve();
    }
    if (command.type === 'dispose') {
      this.installAbortOutcome = 'cancelled';
      this.installController?.abort(new DOMException('处理运行时已释放', 'AbortError'));
      this.probeController?.abort(new DOMException('处理运行时已释放', 'AbortError'));
    }
    const operation = this.commandTail.then(() => this.applyCommand(command));
    this.commandTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async applyCommand(command: ProcessingRuntimeCommand): Promise<void> {
    if (command.type === 'dispose') {
      if (this.disposed) return;
      this.disposed = true;
      this.generation += 1;
      this.installAbortOutcome = 'cancelled';
      this.installController?.abort(new DOMException('处理运行时已释放', 'AbortError'));
      this.probeController?.abort(new DOMException('处理运行时已释放', 'AbortError'));
      this.invalidateCore(new DOMException('处理运行时已释放', 'AbortError'));
      await this.coreDisposal;
      this.unsubscribeEnvironment();
      this.emit();
      this.listeners.clear();
      return;
    }
    this.assertNotDisposed();
    if (command.type === 'refresh-storage') {
      this.storage = await this.inspectStorageSafely();
      this.emit();
      return;
    }
    if (command.type === 'refresh') {
      await this.refresh(true);
      return;
    }
    if (command.type === 'retry') {
      if (
        this.modelConsent
        && (
          this.modelPackage.status === 'missing'
          || this.modelPackage.status === 'paused'
          || this.modelPackage.status === 'failed'
        )
      ) {
        await this.installModels();
        return;
      }
      await this.refresh(false);
      return;
    }
    if (command.type === 'accept-model-download') {
      this.modelConsent = true;
      this.dependencies.writeModelConsent(true);
      await this.installModels();
      return;
    }
  }

  private async installModels(): Promise<void> {
    if (!this.environment.online) {
      throw new ProcessingRuntimeBlockedError({
        status: 'blocked',
        code: 'OFFLINE',
      });
    }
    if (this.environment.visibility === 'hidden') {
      throw new ProcessingRuntimeBlockedError({
        status: 'blocked',
        code: 'PAGE_HIDDEN',
      });
    }
    if (this.installController) return;
    const controller = new AbortController();
    this.installController = controller;
    this.installAbortOutcome = undefined;
    this.modelPackage = {
      ...this.modelPackage,
      status: 'installing',
      error: undefined,
    };
    this.emit();
    try {
      await this.dependencies.installModelPackage({
        signal: controller.signal,
        onProgress: (progress) => {
          if (this.installController !== controller || controller.signal.aborted) return;
          this.modelPackage = {
            status: 'installing',
            progress,
            storedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
          };
          this.emit();
        },
      });
      if (controller.signal.aborted) {
        throw controller.signal.reason
          ?? new DOMException('模型下载已取消', 'AbortError');
      }
      this.installController = undefined;
      this.installAbortOutcome = undefined;
      await this.refresh(false);
    } catch (error) {
      const abortOutcome = controller.signal.aborted
        ? this.consumeInstallAbortOutcome() ?? 'cancelled'
        : undefined;
      if (this.installController === controller) this.installController = undefined;
      if (!controller.signal.aborted) this.installAbortOutcome = undefined;
      const inspection = await this.dependencies.inspectModelPackage().catch(() => ({
        installed: false,
        storedBytes: this.modelPackage.storedBytes,
        totalBytes: this.modelPackage.totalBytes,
      }));
      this.modelPackage = {
        status: abortOutcome === 'paused'
          ? 'paused'
          : abortOutcome
            ? 'missing'
            : 'failed',
        storedBytes: inspection.storedBytes,
        totalBytes: inspection.totalBytes,
        error: abortOutcome ? undefined : messageFor(error),
      };
      this.emit();
      if (!abortOutcome) throw error;
    }
  }

  private async refresh(useCache: boolean): Promise<void> {
    this.environment = this.dependencies.environment.snapshot();
    this.modelPackage = {
      ...this.modelPackage,
      status: 'checking',
      error: undefined,
    };
    this.storage = { status: 'checking' };
    this.capability = undefined;
    this.capabilityError = undefined;
    this.modelProbe = { status: 'pending' };
    this.invalidateCore(new DOMException('处理运行时正在刷新', 'AbortError'));
    this.emit();

    if (!this.environment.online || this.environment.visibility === 'hidden') return;

    const [inspectionResult, storageResult, capabilityResult] = await Promise.allSettled([
      this.dependencies.inspectModelPackage(),
      this.dependencies.inspectStorage(),
      this.dependencies.probeCapability({ useCache }),
    ]);
    this.storage = storageResult.status === 'fulfilled'
      ? storageResult.value
      : {
          status: 'unavailable',
          persisted: false,
          error: messageFor(storageResult.reason),
        };
    if (capabilityResult.status === 'fulfilled') {
      this.capability = capabilityResult.value;
    } else {
      this.capabilityError = messageFor(capabilityResult.reason);
    }
    if (inspectionResult.status === 'fulfilled') {
      this.modelPackage = {
        status: inspectionResult.value.installed ? 'installed' : 'missing',
        storedBytes: inspectionResult.value.storedBytes,
        totalBytes: inspectionResult.value.totalBytes,
      };
    } else {
      this.modelPackage = {
        ...this.modelPackage,
        status: 'failed',
        error: messageFor(inspectionResult.reason),
      };
    }
    this.emit();
    if (
      inspectionResult.status === 'rejected'
      || !inspectionResult.value.installed
      || capabilityResult.status === 'rejected'
      || !capabilityResult.value.ok
    ) {
      return;
    }
    const capability = capabilityResult.value;

    const controller = new AbortController();
    this.probeController = controller;
    this.modelProbe = { status: 'checking' };
    this.emit();
    let result: ModelCapabilityResult;
    try {
      result = await this.dependencies.probeModels({
        backend: capability.backend,
        signal: controller.signal,
        useCache,
        onProgress: (progress) => {
          if (this.probeController !== controller || controller.signal.aborted) return;
          this.modelProbe = { status: 'checking', progress };
          this.emit();
        },
      });
    } catch (error) {
      if (this.probeController !== controller || controller.signal.aborted) return;
      this.probeController = undefined;
      this.modelProbe = {
        status: 'failed',
        error: messageFor(error),
      };
      this.emit();
      return;
    }
    if (this.probeController !== controller || controller.signal.aborted) return;
    this.probeController = undefined;
    this.modelProbe = result.ok && result.provider
      ? { status: 'ready', provider: result.provider }
      : {
          status: 'failed',
          error: result.error ?? '模型能力测试失败',
        };
    this.emit();
  }

  private baseDecision(): Extract<ProcessingRuntimeDecision, { status: 'blocked' }> | undefined {
    if (this.disposed) return { status: 'blocked', code: 'RUNTIME_DISPOSED' };
    if (this.environment.visibility === 'hidden') {
      return { status: 'blocked', code: 'PAGE_HIDDEN' };
    }
    if (!this.environment.online) return { status: 'blocked', code: 'OFFLINE' };
    if (!this.capability) {
      return this.capabilityError
        ? {
            status: 'blocked',
            code: 'CAPABILITY_FAILED',
            detail: this.capabilityError,
          }
        : { status: 'blocked', code: 'CAPABILITY_CHECKING' };
    }
    if (!this.capability.ok) {
      return {
        status: 'blocked',
        code: 'CAPABILITY_FAILED',
        detail: this.capability.reason,
      };
    }
    if (this.modelPackage.status === 'checking') {
      return { status: 'blocked', code: 'MODEL_PACKAGE_CHECKING' };
    }
    if (this.modelPackage.status === 'missing') {
      return {
        status: 'blocked',
        code: this.modelConsent
          ? 'MODEL_PACKAGE_MISSING'
          : 'MODEL_CONSENT_REQUIRED',
      };
    }
    if (this.modelPackage.status === 'installing') {
      return { status: 'blocked', code: 'MODEL_INSTALLING' };
    }
    if (this.modelPackage.status === 'paused') {
      return { status: 'blocked', code: 'MODEL_INSTALL_PAUSED' };
    }
    if (this.modelPackage.status === 'failed') {
      return {
        status: 'blocked',
        code: 'MODEL_INSTALL_FAILED',
        detail: this.modelPackage.error,
      };
    }
    if (this.modelProbe.status === 'pending' || this.modelProbe.status === 'checking') {
      return { status: 'blocked', code: 'MODEL_PROBING' };
    }
    if (this.modelProbe.status === 'failed') {
      return {
        status: 'blocked',
        code: 'MODEL_PROBE_FAILED',
        detail: this.modelProbe.error,
      };
    }
    return undefined;
  }

  private status(): ProcessingRuntimeSnapshot['status'] {
    if (this.disposed) return 'disposed';
    if (this.environment.visibility === 'hidden') return 'suspended';
    if (
      this.modelPackage.status === 'checking'
      || (!this.capability && !this.capabilityError)
      || this.modelProbe.status === 'checking'
      || this.storage.status === 'checking'
    ) {
      return 'checking';
    }
    if (this.modelPackage.status === 'installing') return 'installing';
    return this.baseDecision() ? 'blocked' : 'ready';
  }

  private invalidateCore(reason: unknown): void {
    this.generation += 1;
    if (this.core) this.enqueueCoreDisposal(this.core, reason);
    this.core = undefined;
    this.coreCredential = undefined;
  }

  private enqueueCoreDisposal(core: WebTranslatorCore, reason: unknown): void {
    const disposal = core.dispose(reason);
    this.coreDisposal = Promise.allSettled([
      this.coreDisposal,
      disposal,
    ]).then(() => undefined);
  }

  private consumeInstallAbortOutcome(): 'cancelled' | 'paused' | undefined {
    const outcome = this.installAbortOutcome;
    this.installAbortOutcome = undefined;
    return outcome;
  }

  private async inspectStorageSafely(): Promise<WebStorageSnapshot> {
    try {
      return await this.dependencies.inspectStorage();
    } catch (error) {
      return {
        status: 'unavailable',
        persisted: false,
        error: messageFor(error),
      };
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new ProcessingRuntimeBlockedError({
        status: 'blocked',
        code: 'RUNTIME_DISPOSED',
      });
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // One UI observer must not stop runtime transitions for the others.
      }
    }
  }
}

export function createProcessingRuntime(
  dependencies: ProcessingRuntimeDependencies,
): ProcessingRuntime {
  return new ProcessingRuntimeImplementation(dependencies);
}
