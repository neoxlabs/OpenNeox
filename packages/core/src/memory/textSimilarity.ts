/** 字符 bigram 集合 (中文没有空格分词, 按字对切最稳)。 */
export function getBigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const bigrams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    bigrams.add(normalized.slice(i, i + 2));
  }
  return bigrams;
}

/** Jaccard 系数 (交 / 并), 0~1。 */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);
  if (bigramsA.size === 0 && bigramsB.size === 0) return 1;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 重叠系数 (交 / 较短那条): 一条是另一条的改写或扩写时也接近 1, Jaccard 会被长度差拉低。 */
export function textOverlap(a: string, b: string): number {
  if (a === b) return 1;
  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);
  const min = Math.min(bigramsA.size, bigramsB.size);
  if (min === 0) return 0;
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  return intersection / min;
}
