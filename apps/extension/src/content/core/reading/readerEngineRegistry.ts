import type {
  ReaderEngineAdapter,
  ReaderEngineDetection,
} from './readerEngineContracts';

export type DetectedReaderEngine = {
  adapter: ReaderEngineAdapter;
  detection: ReaderEngineDetection;
};

export class ReaderEngineRegistry {
  constructor(private readonly adapters: readonly ReaderEngineAdapter[]) {}

  detect(): DetectedReaderEngine | null {
    for (const adapter of this.adapters) {
      const detection = adapter.detect();
      if (detection?.confidence === 'strong') {
        return { adapter, detection };
      }
    }
    return null;
  }
}
