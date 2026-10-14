export const translationIconPaths = {
  "languages": "M3 5H15M9 3V5M13 5C12 10 9 14 4 17M5 8C7 12 10 15 14 17M14 21L18 11L22 21M15.5 17H20.5",
  "adjust": "M3 7H7M11 7H21M3 17H13M17 17H21M7 4H11V10H7ZM13 14H17V20H13Z",
  "hourglass": "M5 3H19M5 21H19M7 3V6C7 9 10 10 12 12C14 14 17 15 17 18V21M17 3V6C17 9 14 10 12 12C10 14 7 15 7 18V21M8 18H16",
  "download": "M3 15V19Q3 21 5 21H19Q21 21 21 19V15M7 10L12 15L17 10M12 15V3",
  "imageLoad": "M14 4H5Q3 4 3 6V18Q3 20 5 20H19Q21 20 21 18V11M3 16L8 11L12 15L16 12L21 17M18 2V9M15 6L18 9L21 6",
  "processor": "M8 5H16Q19 5 19 8V16Q19 19 16 19H8Q5 19 5 16V8Q5 5 8 5ZM9 9H15V15H9ZM9 2V5M15 2V5M9 19V22M15 19V22M2 9H5M2 15H5M19 9H22M19 15H22",
  "sparkles": "M12 3L14.4 9.6L21 12L14.4 14.4L12 21L9.6 14.4L3 12L9.6 9.6ZM20 2V6M18 4H22",
  "scan": "M8 3H5Q3 3 3 5V8M16 3H19Q21 3 21 5V8M3 16V19Q3 21 5 21H8M21 16V19Q21 21 19 21H16M7 9H17M7 13H17M7 17H13",
  "type": "M4 7V4H20V7M12 4V20M8 20H16",
  "filter": "M3 4H21L14 12V19L10 21V12ZM7 4L10 8M17 4L14 8",
  "branches": "M12 21V12M12 12L6 6M12 12L18 6M6 10V6H10M14 6H18V10",
  "mesh": "M5 5L17 3L21 14L15 21L3 17ZM5 5L8 11L3 17M17 3L13 10L21 14M8 11L13 10L15 21",
  "textCheck": "M3 5H17M3 10H13M3 15H9M12 17L15 20L21 13",
  "layout": "M4 3V21M20 3V21M8 6H16M8 10H16M8 14H16M8 18H13",
  "eraser": "M14 3Q15.5 1.5 17 3L21 7Q22.5 8.5 21 10L11 20H7L3 16Q1.5 14.5 3 13ZM8 8L16 16M11 20H21",
  "confirm": "M4 12L9 17L20 6",
  "retry": "M20 8A8 8 0 1 0 20 16M20 3V8H15",
  "original": "M5 4H19Q21 4 21 6V18Q21 20 19 20H5Q3 20 3 18V6Q3 4 5 4ZM3 16L8 11L12 15L16 11L21 16M9 8A1.5 1.5 0 1 1 6 8A1.5 1.5 0 1 1 9 8Z",
  "translated": "M5 4H19Q21 4 21 6V18Q21 20 19 20H5Q3 20 3 18V6Q3 4 5 4ZM7 8H17M7 12H17M7 16H13",
  "capture": "M5 6H8L10 3H14L16 6H19Q21 6 21 8V18Q21 20 19 20H5Q3 20 3 18V8Q3 6 5 6ZM16 13A4 4 0 1 1 8 13A4 4 0 1 1 16 13Z",
  "crop": "M8 3V16Q8 17 9 17H21M3 7H15Q17 7 17 9V21",
  "pages": "M6 6H16Q18 6 18 8V20H6ZM10 2H20Q22 2 22 4V16M9 10H15M9 14H15",
  "pageSplit": "M3 4H10V20H3ZM14 4H21V20H14ZM12 2V22",
  "ocrFilter": "M3 5H13M3 10H10M3 15H8M15 7L21 13M21 7L15 13M13 19H21",
  "merge": "M3 5H8L12 9L16 5H21M3 19H8L12 15L16 19H21M12 9V15",
  "bubble": "M5 4H19Q22 4 22 7V14Q22 17 19 17H10L5 21V17Q2 17 2 14V7Q2 4 5 4ZM7 8H17M7 12H14",
  "order": "M5 3V21M2 18L5 21L8 18M12 5H16M12 10H19M12 15H22",
  "mask": "M4 4H20V20H4ZM4 4L20 20M4 10L14 20M10 4L20 14",
  "translateText": "M3 4H15M9 2V4M5 7L13 15M13 4C12 9 8 13 3 15M15 21L19 12L23 21M16.5 18H21.5",
  "inpaint": "M3 16L11 8L18 15L10 23ZM7 12L15 20M11 8L14 5L21 12L18 15M20 3V7M18 5H22"
} as const;

export type TranslationIconKey = keyof typeof translationIconPaths;

export function resolveTranslationIcon(text: string): TranslationIconKey {
  if (text.includes('显示原图')) return 'original';
  if (text.includes('显示译图')) return 'translated';
  if (text.includes('重试')) return 'retry';
  if (/^完成$/.test(text.replace(/^\d+\/\d+\s*/, ''))) return 'confirm';
  if (text.includes('|')) {
    if (text.includes('去字完成')) return 'textCheck';
    if (text.includes('翻译完成')) return 'eraser';
    if (text.includes('细化')) return 'mesh';
    return 'branches';
  }
  if (text.includes('全图翻译')) return 'sparkles';
  if (text.includes('裁剪')) return 'crop';
  if (text.includes('截图')) return 'capture';
  if (text.includes('获取页数')) return 'pages';
  if (text.includes('分页')) return 'pageSplit';
  if (text.includes('排队')) return 'hourglass';
  if (text.includes('准备')) return 'adjust';
  if (text.includes('获取图片')) return 'download';
  if (text.includes('OCR') && text.includes('过滤')) return 'ocrFilter';
  if (text.includes('过滤') || text.includes('误识别检测')) return 'filter';
  if (text.includes('模型')) return 'processor';
  if (text.includes('图片')) return 'imageLoad';
  if (text.includes('检测文本') || text.includes('文本检测')) return 'scan';
  if (text.includes('识别')) return 'type';
  if (text.includes('合并')) return 'merge';
  if (text.includes('气泡')) return 'bubble';
  if (text.includes('排序')) return 'order';
  if (text.includes('排版')) return 'layout';
  if (text.includes('细化')) return 'mesh';
  if (text.includes('遮罩')) return 'mask';
  if (text.includes('去字') || text.includes('去除文字')) return 'inpaint';
  if (text.includes('翻译文本') || text.includes('翻译中')) return 'translateText';
  return 'languages';
}
