import {
  createBrowserModelRuntime,
  createExtensionModelAssetSource,
} from '@shinobu/model-runtime/browser';
import {
  recordPerfRuntimeEvent,
  recordPerfWorkerCall,
} from '@shinobu/diagnostics';
import { requireExtensionRuntime } from './extensionRuntime';

export function createExtensionModelRuntime() {
  const runtime = requireExtensionRuntime();
  const getAssetUrl = runtime.getURL.bind(runtime);
  return createBrowserModelRuntime({
    workerUrl: getAssetUrl('onnxWorker.js'),
    ortPath: getAssetUrl('ort/'),
    modelSource: createExtensionModelAssetSource(getAssetUrl),
    workerPolicy: 'direct-only',
    performanceObserver: {
      recordWorkerCall: recordPerfWorkerCall,
      recordRuntimeEvent: recordPerfRuntimeEvent,
    },
  });
}
