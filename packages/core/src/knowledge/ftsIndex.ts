/**
 * KnowledgeFtsIndex — SQLite FTS5 磁盘索引 (万级知识库的第二档引擎)
 *
 * 设计 (内部设计文档 §5.5 规模预案):
 *   · in-memory BM25 舒适区 ≤ ~500 条; 超过后 knowledge_search 自动切到本引擎
 *   · 零向量: 中文 bigram 预分词 (与 searchEngine.tokenize 同规则) 空格连接后
 *     喂 FTS5 unicode61 — 索引与查询同规则, 保证词法命中一致
 *   · 增量: 按 change_sig (卡片=内容哈希 / 文档=mtime:size:fileId) 只重建变化条目,
 *     文本抽取 (pdftotext 等) 也只对变化文档发生
 *   · 磁盘: {workspace}/.neox/knowledge/_meta/fts.db (`_` 前缀不被 loader 扫);
 *     snippet 源存每条前 16KB, 万条 ≈ 一百多 MB 磁盘, 零 RAM 常驻
 *   · FTS5 不可用 (罕见的裁剪 sqlite) → open 抛错, 调用方回退 in-memory BM25
 */

import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { openAuxiliaryDatabase } from '@neoxlabs/platform/platform/database.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { tokenize, buildSnippetFromText } from './searchEngine.js';
import { extractDocumentText } from './docText.js';
import type { KnowledgeCard, KnowledgeSearchHit } from './types.js';
import type { KnowledgeDocumentStatus } from './documents.js';

/* snippet 源窗口 — 命中定位用, 超出窗口的命中退回 description */
const SNIPPET_SRC_CHARS = 16_000;
/* searchEngine.tokenize 的规则版本 —— 改分词规则时 +1, 旧索引会被整库重建。
 * 1 = [a-z0-9_] + 汉字 bigram; 2 = Unicode 字母数字 + 汉字/假名 bigram + 去附加符号 */
const TOKENIZER_VERSION = 2;
/* 文档文本抽取并发 (pdftotext 子进程) */
const EXTRACT_CONCURRENCY = 8;

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0) + ':' + str.length;
}

interface MetaRow {
  key: string;
  kind: 'card' | 'doc';
  title: string;
  description: string;
  display_path: string;
  source: string | null;
  trust: string | null;
  change_sig: string;
  snippet_src: string;
}

export class KnowledgeFtsIndex {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = openAuxiliaryDatabase(dbPath);
    /* FTS5 不可用会在这里抛 — 调用方捕获后回退 in-memory 引擎 */
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        display_path TEXT NOT NULL,
        source TEXT,
        trust TEXT,
        change_sig TEXT NOT NULL,
        snippet_src TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        key UNINDEXED,
        title_toks,
        body_toks,
        tokenize = 'unicode61'
      );
    `);
    /* 预分词规则变了 (TOKENIZER_VERSION), 旧索引里的 token 是按旧规则切的 —— 条目签名没变,
     * 增量 sync 不会重建它们, 于是旧规则切不出的文字 (俄文/韩文/假名) 永远搜不到。整库清掉重建。 */
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version !== TOKENIZER_VERSION) {
      this.db.exec('DELETE FROM meta; DELETE FROM fts;');
      this.db.pragma(`user_version = ${TOKENIZER_VERSION}`);
    }
  }

  /**
   * 增量同步 — 变化的条目重建, 没变的零成本跳过, 消失的删除。
   * 文档文本抽取只对 sig 变化的发生 (限并发)。
   */
  async sync(
    cards: KnowledgeCard[],
    docs: KnowledgeDocumentStatus[],
  ): Promise<{ upserted: number; removed: number; failures: Array<{ name: string; reason: string }> }> {
    const existing = new Map<string, string>(
      (this.db.prepare('SELECT key, change_sig FROM meta').all() as Array<{ key: string; change_sig: string }>)
        .map((r) => [r.key, r.change_sig]),
    );
    const liveKeys = new Set<string>();
    const pending: Array<{ row: MetaRow; titleText: string; bodyText: string }> = [];

    for (const card of cards) {
      const key = `card:${card.id}`;
      liveKeys.add(key);
      const sig = djb2(
        `${card.meta.title}\u0000${card.meta.description}\u0000${(card.meta.keywords ?? []).join(',')}\u0000${card.meta.trust ?? ''}\u0000${card.body}`,
      );
      if (existing.get(key) === sig) continue;
      pending.push({
        row: {
          key,
          kind: 'card',
          title: card.meta.title,
          description: card.meta.description,
          display_path: card.displayPath,
          source: card.meta.source ?? null,
          trust: card.meta.trust ?? null,
          change_sig: sig,
          snippet_src: card.body.slice(0, SNIPPET_SRC_CHARS),
        },
        titleText: `${card.meta.title} ${card.meta.description} ${(card.meta.keywords ?? []).join(' ')}`,
        bodyText: card.body,
      });
    }

    /* 文档: sig 变了才抽文本 (限并发) */
    const changedDocs = docs.filter((d) => {
      const key = `doc:${d.id}`;
      liveKeys.add(key);
      return existing.get(key) !== `${d.mtimeMs}:${d.size}:${d.fileId ?? ''}`;
    });
    let cursor = 0;
    const failures: Array<{ name: string; reason: string }> = [];
    const docRows: Array<{ row: MetaRow; titleText: string; bodyText: string }> = new Array(changedDocs.length);
    const worker = async (): Promise<void> => {
      while (cursor < changedDocs.length) {
        const index = cursor++;
        const d = changedDocs[index];
        let text = '';
        /* 抽取失败: 这一轮按文件名入索引, 但 change_sig 不能写成"已处理"的真签名 ——
         * 否则空 body 连同签名落盘, 文件不改就永远不会重抽 (重启也不会)。 */
        let sig = `${d.mtimeMs}:${d.size}:${d.fileId ?? ''}`;
        try {
          text = await extractDocumentText(d.path, d.mtimeMs, d.fileId);
        } catch (err: any) {
          failures.push({ name: d.name, reason: err?.message || String(err) });
          sig = `extract-failed:${sig}`;
        }
        docRows[index] = {
          row: {
            key: `doc:${d.id}`,
            kind: 'doc',
            title: d.name,
            description: `资料文件 (${d.collection}) — 原文件路径引用, 用 readfile 直接读`,
            display_path: d.path,
            source: d.fileId ? `read_document(file_id="${d.fileId}") 可读解析后全文` : null,
            trust: null,
            change_sig: sig,
            snippet_src: text.slice(0, SNIPPET_SRC_CHARS),
          },
          titleText: `${d.name} ${d.path}`,
          bodyText: text,
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, changedDocs.length) }, worker));
    pending.push(...docRows.filter(Boolean));

    const removedKeys = [...existing.keys()].filter((k) => !liveKeys.has(k));

    const upsertMeta = this.db.prepare(`
      INSERT INTO meta (key, kind, title, description, display_path, source, trust, change_sig, snippet_src)
      VALUES (@key, @kind, @title, @description, @display_path, @source, @trust, @change_sig, @snippet_src)
      ON CONFLICT(key) DO UPDATE SET
        kind=excluded.kind, title=excluded.title, description=excluded.description,
        display_path=excluded.display_path, source=excluded.source, trust=excluded.trust,
        change_sig=excluded.change_sig, snippet_src=excluded.snippet_src
    `);
    const deleteFts = this.db.prepare('DELETE FROM fts WHERE key = ?');
    const insertFts = this.db.prepare('INSERT INTO fts (key, title_toks, body_toks) VALUES (?, ?, ?)');
    const deleteMeta = this.db.prepare('DELETE FROM meta WHERE key = ?');

    const applyAll = this.db.transaction(() => {
      for (const item of pending) {
        upsertMeta.run(item.row as any);
        deleteFts.run(item.row.key);
        insertFts.run(item.row.key, tokenize(item.titleText).join(' '), tokenize(item.bodyText).join(' '));
      }
      for (const key of removedKeys) {
        deleteMeta.run(key);
        deleteFts.run(key);
      }
    });
    applyAll();

    if (pending.length > 0 || removedKeys.length > 0) {
      cliLogger.info('KNOWLEDGE', `FTS index synced: +${pending.length} / -${removedKeys.length} (total ${liveKeys.size})`);
    }
    return { upserted: pending.length, removed: removedKeys.length, failures };
  }

  /** 与 in-memory 引擎同构的搜索接口 — 返回 KnowledgeSearchHit (card 为重建的轻量壳) */
  search(query: string, limit = 5): KnowledgeSearchHit[] {
    const toks = Array.from(new Set(tokenize(query))).filter(Boolean);
    if (toks.length === 0) return [];
    /* OR 语义对齐 in-memory BM25 (任一 token 贡献得分); token 只含 Unicode 字母/数字/_, 引号包裹安全 */
    const match = toks.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    const rows = this.db.prepare(`
      SELECT m.*, bm25(fts, 0, 3.0, 1.0) AS score
      FROM fts JOIN meta m ON m.key = fts.key
      WHERE fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(match, limit) as Array<MetaRow & { score: number }>;
    return rows.map((r) => ({
      card: {
        id: r.key,
        filePath: r.display_path,
        displayPath: r.display_path,
        origin: 'workspace' as const,
        meta: {
          title: r.title,
          description: r.description,
          source: r.source ?? undefined,
          trust: (r.trust === 'draft' || r.trust === 'verified' ? r.trust : undefined),
        },
        body: '',
      },
      /* fts5 bm25() 越小越好 (负值) — 取反对齐"越大越好"的外部语义 */
      score: -r.score,
      snippet: buildSnippetFromText(r.snippet_src, toks, r.description),
    }));
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

export function ftsIndexPathFor(workDir: string): string {
  return path.join(workDir, '.neox', 'knowledge', '_meta', 'fts.db');
}
