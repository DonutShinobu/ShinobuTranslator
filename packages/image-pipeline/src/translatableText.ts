type OrderedTextSource<Region extends { sourceText: string }> = {
  ordered: readonly Region[];
};

const unicodeLetterOrNumber = /[\p{L}\p{N}]/u;

export function hasTranslatableText<Region extends { sourceText: string }>(
  source: OrderedTextSource<Region>,
): boolean {
  return source.ordered.some((region) => unicodeLetterOrNumber.test(region.sourceText));
}
