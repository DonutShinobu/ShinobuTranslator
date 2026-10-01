import type {
  PipelineFontDescriptors,
  PlatformProvider,
} from '../../runtime/platform';

export const TYPESET_FONT_WEIGHT = 700;

const variableFontDescriptors = {
  style: 'normal',
  weight: '200 900',
} satisfies PipelineFontDescriptors;

const typesetFontAssets = [
  {
    path: 'fonts/SourceHanSansCN-VF.ttf.woff2',
    family: 'MTX-SourceHanSans-CN',
  },
  {
    path: 'fonts/SourceHanSansTW-VF.ttf.woff2',
    family: 'MTX-SourceHanSans-TW',
  },
] as const;

export function resolveTypesetFontFamily(targetLang?: string): string {
  return targetLang === 'zh-CHT'
    ? '"MTX-SourceHanSans-TW", "Noto Sans CJK TC", "PingFang TC", sans-serif'
    : '"MTX-SourceHanSans-CN", "Noto Sans CJK SC", "PingFang SC", sans-serif';
}

export function registerTypesetFonts(
  platform: PlatformProvider,
  resolveAssetUrl: (path: string) => string,
  targetLang?: string,
): void {
  const fontFamily = targetLang === undefined ? undefined : resolveTypesetFontFamily(targetLang);
  for (const font of typesetFontAssets) {
    if (fontFamily && !fontFamily.includes(`"${font.family}"`)) continue;
    platform.registerFont(
      resolveAssetUrl(font.path),
      font.family,
      variableFontDescriptors,
    );
  }
}

export function formatTypesetFont(
  fontSize: number,
  fontFamily: string,
): string {
  return `${TYPESET_FONT_WEIGHT} ${fontSize}px ${fontFamily}`;
}
