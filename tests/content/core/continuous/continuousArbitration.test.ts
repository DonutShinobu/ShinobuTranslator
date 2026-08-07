import { describe, expect, it } from 'vitest';
import type { ImageTranslationExecutionModule } from '../../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { createImageTranslationExecutionArbiter } from '../../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter';

const execution: ImageTranslationExecutionModule = {
  start: () => ({
    result: new Promise(() => undefined),
    signal: new AbortController().signal,
    cancel: () => undefined,
    progress: () => () => undefined,
  }),
};

describe('continuous translation arbitration', () => {
  it('defers behind explicit work and yields when explicit work begins later', () => {
    const arbiter = createImageTranslationExecutionArbiter(execution);
    const explicit = arbiter.begin({ owner: 'screenshot', origin: 'explicit' });
    expect(explicit.status).toBe('active');

    expect(arbiter.begin({
      owner: 'continuous',
      origin: 'automatic',
      yieldToExplicit: true,
    })).toEqual({ status: 'deferred' });

    if (explicit.status === 'active') explicit.activity.end();
    const continuous = arbiter.begin({
      owner: 'continuous',
      origin: 'automatic',
      yieldToExplicit: true,
    });
    expect(continuous.status).toBe('active');

    const replacement = arbiter.begin({ owner: 'inline-image', origin: 'explicit' });
    expect(replacement.status).toBe('active');
    if (continuous.status === 'active') {
      expect(continuous.activity.signal.aborted).toBe(true);
    }
  });
});
