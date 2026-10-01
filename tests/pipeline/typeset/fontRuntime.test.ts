import { describe, expect, it, vi } from 'vitest';

import type { PlatformProvider } from '../../../packages/image-pipeline/src/runtime/platform';
import {
  formatTypesetFont,
  registerTypesetFonts,
  resolveTypesetFontFamily,
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

  it.each(['zh-CN', 'zh-CHS', 'ja', 'en', 'zh-CHT'])('registers the same family used by final typesetting (%s)', (targetLang) => {
    const registerFont = vi.fn();
    registerTypesetFonts({ registerFont } as unknown as PlatformProvider, (path) => `extension://${path}`, targetLang);
    expect(registerFont).toHaveBeenCalledOnce();
    const family = targetLang === 'zh-CHT' ? 'MTX-SourceHanSans-TW' : 'MTX-SourceHanSans-CN';
    expect(registerFont.mock.calls[0][1]).toBe(family);
    expect(resolveTypesetFontFamily(targetLang)).toContain(`"${family}"`);
    expect(registerFont.mock.calls[0][2]).toEqual({ style: 'normal', weight: '200 900' });
  });
});
