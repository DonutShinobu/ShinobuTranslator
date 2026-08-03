import type {
  ModelRuntimeEvent,
  ModelRuntimePerformanceObserver,
  ModelRuntimeWorkerCall,
} from '../contracts';

let activeObserver: ModelRuntimePerformanceObserver | undefined;

export function configureModelRuntimePerformanceObserver(
  observer: ModelRuntimePerformanceObserver | undefined,
): void {
  activeObserver = observer;
}

export function recordModelRuntimeWorkerCall(
  call: ModelRuntimeWorkerCall,
): void {
  activeObserver?.recordWorkerCall(call);
}

export function recordModelRuntimeEvent(event: ModelRuntimeEvent): void {
  activeObserver?.recordRuntimeEvent?.(event);
}
