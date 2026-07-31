import type {
  PipelineHostDocumentLifecycle,
} from './contracts';

export function createFirefoxPipelineHostLifecycle():
PipelineHostDocumentLifecycle {
  return {
    isAvailable() {
      return false;
    },
    accepts() {
      return false;
    },
    async exists() {
      return false;
    },
    async create() {
      throw new TypeError(
        'Firefox Event Page direct pipeline hosting is unavailable',
      );
    },
    async close() {
      return false;
    },
  };
}
