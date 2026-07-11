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
  };
}

export class PhotoStateStore {
  private readonly states = new Map<string, PhotoState>();

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

  delete(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    this.releaseStateUrls(state);
    this.states.delete(key);
  }

  dispose(): void {
    for (const state of this.states.values()) {
      this.releaseStateUrls(state);
    }
    this.states.clear();
  }

  private trim(protectedKey: string): void {
    while (this.states.size > this.cacheLimit) {
      const oldestKey = this.states.keys().next().value as string | undefined;
      if (!oldestKey || oldestKey === protectedKey) break;
      this.delete(oldestKey);
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
