/**
 * 索引用的分词 —— **只能有这一份**。
 *
 *   写进 bm25_terms 的词 (indexingCpuWorker) 和搜索时切出来的词 (indexDbWorker)
 *   必须逐字节同规则。两边各写一份的话, 只要有一点点不同 —— 大小写、长度下界、
 *   正则里少一个字符 —— 搜索就永远返回 0 结果, **而且不报任何错**。
 *   这种"配了等于没配"的形状是最难查的一类, 所以直接从源头上不给它机会。
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_$]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && token.length < 40);
}
