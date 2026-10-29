/**
 * Knowledge searchEngine — in-memory BM25 (字段加权变体)
 *
 * 设计 §2.2: 数百卡规模, in-memory 倒排足够; 不落 SQLite、不依赖 desktop 侧
 * embeddingBridge。接口保持窄 (build + search), 未来万级语料要换 hybrid 引擎时
 * 只动这个文件。
 *
 * 分词: ASCII 按单词切; CJK 按 bigram 切 (中文两字一 token, 单字查询退化为 unigram)。
 * 字段加权: title ×3 / description ×2.5 / keywords ×2.5 / body ×1 — 加权计入 tf。
 */

import type { KnowledgeCard, KnowledgeSearchHit } from './types.js';

const K1 = 1.2;
const B = 0.75;
const SNIPPET_CONTEXT_LINES = 3;

interface DocEntry {
  card: KnowledgeCard;
  /** token → 加权 tf */
  tf: Map<string, number>;
  /** 加权 doc 长度 (Σtf) */
  length: number;
}

// ============================================================================
// 分词
// ============================================================================

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const TOKEN_CHUNK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])[\p{L}\p{N}_])+/gu;

function foldText(text: string): string {
  /* NFKC 折全角; NFD 后去掉附加符号再 NFC 合回。假名后面的浊点/半浊点 (ポ = ホ + ゚) 是字义的一部分, 保留 */
  return text
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/(?<![\p{Script=Hiragana}\p{Script=Katakana}])\p{M}+/gu, '')
    .normalize('NFC')
    .toLowerCase();
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const chunks = foldText(text).match(TOKEN_CHUNK_RE);
  if (!chunks) return tokens;
  for (const chunk of chunks) {
    if (CJK_RE.test(chunk)) {
      if (chunk.length === 1) {
        tokens.push(chunk);
      } else {
        for (let i = 0; i < chunk.length - 1; i++) tokens.push(chunk.slice(i, i + 2));
      }
    } else {
      tokens.push(chunk);
    }
  }
  return tokens;
}

// ============================================================================
// 引擎
// ============================================================================

export class KnowledgeSearchEngine {
  private docs: DocEntry[] = [];
  /** token → 含该 token 的 doc 数 */
  private df = new Map<string, number>();
  private avgLength = 0;

  build(cards: KnowledgeCard[]): void {
    this.docs = [];
    this.df = new Map();

    for (const card of cards) {
      const tf = new Map<string, number>();
      const addField = (text: string | undefined, weight: number): void => {
        if (!text) return;
        for (const token of tokenize(text)) {
          tf.set(token, (tf.get(token) ?? 0) + weight);
        }
      };
      addField(card.meta.title, 3);
      addField(card.meta.description, 2.5);
      addField(card.meta.keywords?.join(' '), 2.5);
      addField(card.body, 1);

      let length = 0;
      for (const v of tf.values()) length += v;
      this.docs.push({ card, tf, length });
      for (const token of tf.keys()) {
        this.df.set(token, (this.df.get(token) ?? 0) + 1);
      }
    }

    this.avgLength =
      this.docs.length > 0
        ? this.docs.reduce((sum, d) => sum + d.length, 0) / this.docs.length
        : 0;
  }

  search(query: string, limit = 5): KnowledgeSearchHit[] {
    const queryTokens = Array.from(new Set(tokenize(query)));
    if (queryTokens.length === 0 || this.docs.length === 0) return [];

    const n = this.docs.length;
    const hits: KnowledgeSearchHit[] = [];

    for (const doc of this.docs) {
      let score = 0;
      for (const token of queryTokens) {
        const tf = doc.tf.get(token);
        if (!tf) continue;
        const df = this.df.get(token) ?? 1;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / (this.avgLength || 1)));
      }
      if (score <= 0) continue;
      hits.push({ card: doc.card, score, snippet: buildSnippet(doc.card, queryTokens) });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/** 正文中首个命中行 ±N 行做 snippet; 正文无命中时退回 description */
function buildSnippet(card: KnowledgeCard, queryTokens: string[]): string {
  return buildSnippetFromText(card.body, queryTokens, card.meta.description);
}

/** 公共 snippet 构建 — in-memory BM25 与 FTS5 磁盘索引共用 */
export function buildSnippetFromText(body: string, queryTokens: string[], fallback: string): string {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineTokens = new Set(tokenize(lines[i]));
    if (queryTokens.some((t) => lineTokens.has(t))) {
      const start = Math.max(0, i - SNIPPET_CONTEXT_LINES);
      const end = Math.min(lines.length, i + SNIPPET_CONTEXT_LINES + 1);
      return lines.slice(start, end).join('\n').trim();
    }
  }
  return fallback;
}
