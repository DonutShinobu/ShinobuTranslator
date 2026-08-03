import { describe, expect, it, vi } from 'vitest';

import type { PlatformProvider } from '../../../packages/image-pipeline/src/runtime/platform';
import {
  formatTypesetFont,
  registerTypesetFonts,
  TYPESET_FONT_WEIGHT,
} from '../../../packages/image-pipeline/src/pipeline/typeset/fontRuntime';

describe('typeset font runtime', () => {
  it('uses the requested bold weight for canvas measurement and rendering', () => {
    expect(TYPESET_FONT_WEIGHT).toBe(700);
    expect(formatTypesetFont(24, '"MTX-SourceHanSans-CN", sans-serif'))
      .toBe('700 24px "MTX-SourceHanSans-CN", sans-serif');
  });

  it('registers both Source Han Sans variable fonts with their full weight range', () => {
    const registerFont = vi.fn();
    const platform = {
      registerFont,
    } as unknown as PlatformProvider;

    registerTypesetFonts(platform, (path) => `extension://${path}`);

    expect(registerFont).toHaveBeenCalledTimes(2);
    expect(registerFont).toHaveBeenNthCalledWith(
      1,
      'extension://fonts/SourceHanSansCN-VF.ttf.woff2',
      'MTX-SourceHanSans-CN',
      { style: 'normal', weight: '200 900' },
    );
    expect(registerFont).toHaveBeenNthCalledWith(
      2,
      'extension://fonts/SourceHanSansTW-VF.ttf.woff2',
      'MTX-SourceHanSans-TW',
      { style: 'normal', weight: '200 900' },
    );
  });
});
