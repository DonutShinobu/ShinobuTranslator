import type { ModelRuntime } from './contracts';
import { createModelRegistry } from './runtime/modelRegistry';
import {
  createSession,
  disposeAll,
  disposeSession,
  runDetectWithGpuPreprocess,
  runInference,
} from './runtime/onnxNodeBridge';
import {
  loadManifestNode,
  resolveModelFilePath,
} from './runtime/modelRegistryNode';
import type { DiagnosticLogObserver } from '@shinobu/diagnostics';
import type { ModelRuntimePerformanceObserver } from './contracts';
import { configureModelRuntimePerformanceObserver } from './runtime/performanceObserver';

export type NodeModelRuntimeOptions = {
  manifestRoot: string;
  modelRoot: string;
  observer?: DiagnosticLogObserver;
  performanceObserver?: ModelRuntimePerformanceObserver;
};

export function createNodeModelRuntime(
  options: NodeModelRuntimeOptions,
): ModelRuntime {
  configureModelRuntimePerformanceObserver(options.performanceObserver);
  const registry = createModelRegistry({
    environment: 'node',
    backend: { createSession, disposeSession, disposeAll },
    loadManifest: () => loadManifestNode(options.manifestRoot),
    resolveAsset: (asset) => resolveModelFilePath(asset, options.modelRoot),
    observer: options.observer,
    performanceObserver: options.performanceObserver,
  });
  return Object.freeze({
    readModel: registry.readModel,
    getSession: registry.getSession,
    run: runInference,
    runImage: runDetectWithGpuPreprocess,
    async readTextResource(url: string) {
      const fs = await import('node:fs/promises');
      return fs.readFile(url, 'utf8');
    },
    releaseSession: registry.releaseSession,
    dispose: registry.dispose,
  });
}

export type { ModelRuntime } from './contracts';
