import { describe, expect, it } from 'vitest';
import { resolveTranslationIcon, translationIconPaths } from '../../../apps/extension/src/content/core/ui/translationIcons';

describe('translation stage icons', () => {
  it('keeps real pipeline phases distinct, including filters, screenshots and reading prefixes', () => {
    const labels = ['翻译', '准备中', '获取图片中', '排队中', '加载图片中', '加载模型中', '文本检测中', '文字识别中', '过滤 OCR 误识别', '大模型误识别过滤中', '合并文本中', '翻译文本中', '生成遮罩中', '细化遮罩中', '去除文字中', '气泡检测中', '文本排序中', '文字排版中', 'Gemini 全图翻译中', '1/12 完成', '显示原图', '显示译图', '重试', '截图中', '裁剪截图中', '正在获取页数…', '正在检测分页…'];
    const icons = labels.map(resolveTranslationIcon);
    expect(new Set(icons).size).toBe(labels.length);
    expect(new Set(icons.map(key => translationIconPaths[key])).size).toBe(labels.length);
    expect(resolveTranslationIcon('1/12 大模型误识别过滤中')).toBe('filter');
    expect(resolveTranslationIcon('2/12 翻译完成 | 去字中')).toBe('eraser');
    expect(resolveTranslationIcon('翻译中 | 去字完成')).toBe('textCheck');
    expect(resolveTranslationIcon('翻译待执行 | 去字待执行')).toBe('branches');
  });
});
