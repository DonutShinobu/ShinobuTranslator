import type { ModelRuntime } from './contracts';
import {
  createModelRegistry,
} from './runtime/modelRegistry';
import type { ModelAssetSource } from './runtime/modelSource';
export {
  createExtensionModelAssetSource,
  createOriginModelAssetSource,
} from './runtime/modelSource';
import {
  configureOnnxWorkerBootstrap,
  createSession,
  disposeAll,
  disposeSession,
  runDetectWithGpuPreprocess,
  runInference,
  type WorkerBootstrapPolicy,
} from './runtime/onnxWorkerBridge';
import type { DiagnosticLogObserver } from '@shinobu/diagnostics';
import type { ModelRuntimePerformanceObserver } from './contracts';
import { configureModelRuntimePerformanceObserver } from './runtime/performanceObserver';

export type BrowserModelRuntimeOptions = {
  workerUrl: string;
  ortPath: string;
  modelSource: ModelAssetSource;
  workerPolicy: WorkerBootstrapPolicy;
  observer?: DiagnosticLogObserver;
  performanceObserver?: ModelRuntimePerformanceObserver;
};

export function createBrowserModelRuntime(
  options: BrowserModelRuntimeOptions,
): ModelRuntime {
  configureOnnxWorkerBootstrap({
    scriptUrl: options.workerUrl,
    ortPath: options.ortPath,
    policy: options.workerPolicy,
  });
  configureModelRuntimePerformanceObserver(options.performanceObserver);
  const registry = createModelRegistry({
    environment: 'browser',
    source: options.modelSource,
    backend: { createSession, disposeSession, disposeAll },
    observer: options.observer,
    performanceObserver: options.performanceObserver,
  });
  return Object.freeze({
    readModel: registry.readModel,
    getSession: registry.getSession,
    run: runInference,
    runImage: runDetectWithGpuPreprocess,
    async readTextResource(url: string) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`模型文本资源读取失败: ${response.status}`);
      }
      return response.text();
    },
    releaseSession: registry.releaseSession,
    dispose: registry.dispose,
  });
}

export type { ModelRuntime } from './contracts';
export type { ModelAssetSource } from './runtime/modelSource';
