type GoogleTranslateSegment = [string?, string?, unknown?, unknown?];

function normalizeLangCode(code: string): string {
  const normalized = code.trim().toLowerCase();
  if (!normalized) {
    return 'auto';
  }
  if (normalized === 'jp') {
    return 'ja';
  }
  if (normalized === 'zh' || normalized === 'zh-chs' || normalized === 'zh_cn' || normalized === 'zh-cn') {
    return 'zh-CN';
  }
  if (normalized === 'zh-cht' || normalized === 'zh_tw' || normalized === 'zh-tw') {
    return 'zh-TW';
  }
  if (normalized === 'en-us') {
    return 'en';
  }
  return normalized;
}

function parseGoogleTranslateResponse(data: unknown): string {
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Google 翻译响应格式异常');
  }
  const segments = data[0] as GoogleTranslateSegment[];
  const translated = segments
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
    .join('')
    .trim();
  if (!translated) {
    throw new Error('Google 翻译响应为空');
  }
  return translated;
}

export async function googleWebTranslate(text: string, from: string, to: string): Promise<string> {
  const source = normalizeLangCode(from);
  const target = normalizeLangCode(to);
  const params = new URLSearchParams({
    client: 'gtx',
    sl: source,
    tl: target,
    dt: 't',
    q: text,
  });
  const endpoint = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;

  const response = await fetch(endpoint, {
    method: 'GET',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Google 翻译请求失败: ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  return parseGoogleTranslateResponse(payload);
}
