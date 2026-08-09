import type { ReadingModeAdapter, SiteAdapter } from '../types';

/** Bridges URL-oriented site adapters into the strict shared reading-mode contract. */
export function createSiteReadingModeAdapter(adapter: SiteAdapter): ReadingModeAdapter {
  return {
    getReadingContextKey: () => adapter.getReadingContextKey?.() ?? null,
    discoverReadingPages: (signal) => adapter.discoverReadingPages?.(signal)
      ?? Promise.resolve({ status: 'incomplete', reason: 'metadata-unavailable' }),
    getVisiblePages: () => adapter.getVisiblePages?.() ?? [],
    createBottomBarAnchor: () => adapter.createBottomBarAnchor?.() ?? null,
    applyImageByKey: (key, url) => adapter.applyImageByKey?.(key, url),
    ...(adapter.prepareReadingPage
      ? {
          prepareReadingPage: (page, signal) => adapter.prepareReadingPage!(page, signal),
        }
      : {}),
    ...(adapter.planReadingLogicalPages
      ? {
          planReadingLogicalPages: (pages, signal) => (
            adapter.planReadingLogicalPages!(pages, signal)
          ),
        }
      : {}),
    ...(adapter.splitReadingLogicalPageResult
      ? {
          splitReadingLogicalPageResult: (page, image, debug, signal) => (
            adapter.splitReadingLogicalPageResult!(page, image, debug, signal)
          ),
        }
      : {}),
  };
}
