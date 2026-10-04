import { renderEditableTextLayer } from '@shinobu/image-pipeline/editor';
import type { EditableTextLayer } from '@shinobu/image-pipeline/editor';
import type { PlatformProvider } from '@shinobu/image-pipeline';
import { resolveRuntimeAssetUrl } from '../ui/styles';

const fontLoads = new Map<string, Promise<void>>();
const platform: PlatformProvider = {
  createCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    return canvas;
  },
  createImage: () => new Image(),
  loadImage: async (url) => {
    const image = new Image(); image.src = url;
    await image.decode(); return image;
  },
  createImageData: (width, height) => new ImageData(width, height),
  registerFont: () => {},
  waitForFonts: async () => {},
};

export async function loadBrowserTypesetFonts(targetLang: string): Promise<void> {
  const suffix = targetLang === 'zh-CHT' ? 'TW' : 'CN';
  let loading = fontLoads.get(suffix);
  if (!loading) {
    loading = (async () => {
      const url = resolveRuntimeAssetUrl(`fonts/SourceHanSans${suffix}-VF.ttf.woff2`);
      if (!url) throw new Error('无法加载排版字体');
      const response = await fetch(url);
      if (!response.ok) throw new Error('无法加载排版字体');
      const font = new FontFace(`MTX-SourceHanSans-${suffix}`, await response.arrayBuffer(), { weight: '200 900' });
      await font.load(); document.fonts.add(font);
    })();
    fontLoads.set(suffix, loading);
    void loading.catch(() => fontLoads.delete(suffix));
  }
  await loading;
}

export async function renderBrowserTextLayer(
  region: EditableTextLayer['region'], targetLang: string,
): Promise<EditableTextLayer | null> {
  await loadBrowserTypesetFonts(targetLang);
  return renderEditableTextLayer(region, targetLang, platform);
}

export async function loadLayerImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally { URL.revokeObjectURL(url); }
}
