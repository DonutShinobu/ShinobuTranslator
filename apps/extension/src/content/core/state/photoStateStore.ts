import type { PhotoState } from '../types';

const defaultPhotoStateCacheLimit = 200;

export type PhotoStateUrlApi = Pick<typeof URL, 'revokeObjectURL'>;

export function createInitialPhotoState(originalUrl: string): PhotoState {
  return {
    status: 'idle',
    mode: 'original',
    originalUrl,
    translatedUrl: undefined,
    debugOriginalUrl: undefined,
    debugLogData: undefined,
    showTypesetDebug: false,
    showEraseDebug: false,
    stageText: '',
    elapsedText: '',
    stageTimingCard: undefined,
    errorText: '',
    errorDetailCard: undefined,
    contextNoticeText: undefined,
  };
}

export class PhotoStateStore {
  private readonly states = new Map<string, PhotoState>();
  private readonly protectedKeys = new Map<string, number>();

  constructor(
    private readonly cacheLimit = defaultPhotoStateCacheLimit,
    private readonly urlApi: PhotoStateUrlApi = URL,
  ) {}

  get(key: string): PhotoState | undefined {
    return this.states.get(key);
  }

  ensure(key: string, originalUrl: string): PhotoState {
    const existing = this.states.get(key);
    if (existing) return existing;

    const state = createInitialPhotoState(originalUrl);
    this.states.set(key, state);
    this.trim(key);
    return state;
  }

  protect(key: string): () => void {
    this.protectedKeys.set(key, (this.protectedKeys.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.protectedKeys.get(key) ?? 0;
      if (count <= 1) this.protectedKeys.delete(key);
      else this.protectedKeys.set(key, count - 1);
      this.trim();
    };
  }

  delete(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    this.releaseStateUrls(state);
    this.states.delete(key);
    this.protectedKeys.delete(key);
  }

  dispose(): void {
    for (const state of this.states.values()) {
      this.releaseStateUrls(state);
    }
    this.states.clear();
    this.protectedKeys.clear();
  }

  private trim(recentKey?: string): void {
    while (this.states.size > this.cacheLimit) {
      let evictableKey: string | undefined;
      for (const key of this.states.keys()) {
        if (key === recentKey || this.protectedKeys.has(key)) continue;
        evictableKey = key;
        break;
      }
      if (!evictableKey) break;
      this.delete(evictableKey);
    }
  }

  private releaseStateUrls(state: PhotoState): void {
    if (state.translatedUrl) {
      this.urlApi.revokeObjectURL(state.translatedUrl);
      state.translatedUrl = undefined;
    }
    if (state.debugOriginalUrl) {
      this.urlApi.revokeObjectURL(state.debugOriginalUrl);
      state.debugOriginalUrl = undefined;
    }
    state.debugLogData = undefined;
    state.errorDetailCard = undefined;
  }
}
