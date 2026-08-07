import type { ExtensionPort } from '../../shared/extensionRuntime';

type ContentCoreLifecycle = {
  stop(): void;
};

type PageLifecycleTarget = {
  addEventListener(type: 'pagehide', listener: (event: PageTransitionEvent) => void): void;
  removeEventListener(type: 'pagehide', listener: (event: PageTransitionEvent) => void): void;
};

export function bindContentLifecycle(
  core: ContentCoreLifecycle,
  port: Pick<ExtensionPort, 'disconnect'> | null,
  target: PageLifecycleTarget = window,
): () => void {
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    target.removeEventListener('pagehide', onPageHide);
    core.stop();
    try {
      port?.disconnect();
    } catch {
      // The browser may have already invalidated the extension context.
    }
  };
  const onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) stop();
  };
  target.addEventListener('pagehide', onPageHide);
  return stop;
}
