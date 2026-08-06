import {
  createBrowserModelRuntime,
  createExtensionModelAssetSource,
  createOriginModelAssetSource,
  type BrowserModelRuntimeOptions,
} from '@shinobu/model-runtime/browser';
import {
  recordPerfRuntimeEvent,
  recordPerfWorkerCall,
} from '@shinobu/diagnostics';
import { getExtensionAssetRuntime } from '../shared/extensionRuntime';

type BenchmarkExtensionRuntime = {
  getURL(path: string): string;
};

const performanceObserver = {
  recordWorkerCall: recordPerfWorkerCall,
  recordRuntimeEvent: recordPerfRuntimeEvent,
};

export function createBenchmarkModelRuntimeOptions(
  runtime: BenchmarkExtensionRuntime | null = getExtensionAssetRuntime(),
  pageUrl = globalThis.location?.href ?? 'http://localhost/',
): BrowserModelRuntimeOptions {
  if (runtime) {
    const getAssetUrl = runtime.getURL.bind(runtime);
    return {
      workerUrl: getAssetUrl('onnxWorker.js'),
      ortPath: getAssetUrl('ort/'),
      modelSource: createExtensionModelAssetSource(getAssetUrl),
      workerPolicy: 'direct-only',
      performanceObserver,
    };
  }

  const originRoot = new URL('/', pageUrl).toString();
  return {
    workerUrl: new URL('onnxWorker.js', originRoot).toString(),
    ortPath: new URL('ort/', originRoot).toString(),
    modelSource: createOriginModelAssetSource(originRoot),
    workerPolicy: 'direct-then-blob',
    performanceObserver,
  };
}

export function createBenchmarkModelRuntime() {
  return createBrowserModelRuntime(createBenchmarkModelRuntimeOptions());
}
