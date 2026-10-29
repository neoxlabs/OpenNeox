/**
 * indexDbWorker —— 代码索引库 (chunks / bm25_terms / chunk_symbols) 的唯一持有者。
 *
 *   这个 worker 里的每一行同步 SQLite 都曾经跑在 Electron 主线程上。搬进来之后
 *   主线程对索引的全部参与就只剩 postMessage —— **无论索引在干多重的活, UI 都不会掉帧**。
 *
 * 顺带在这里根治了三条搜索路径上的老问题 (它们过去也都在主线程上):
 *
 *   1. **每个候选 chunk 打一次 term 查询**。原来 `bm25Search` 对 N 个候选执行
 *      N 次 `SELECT term, tf FROM bm25_terms WHERE chunk_id = ?`。本机这个库
 *      224MB, 一个常见词的候选轻松上千 —— 那就是上千次查询串在一起。
 *      现在一条语句取回: `WHERE chunk_id IN (...) AND term IN (...)`,
 *      而且只取**查询词**的 tf (BM25 打分只用得上这些, 取回全部纯属浪费)。
 *
 *   2. **IN (...) 不设上限**。SQLite 的参数上限是 32766, 候选一多直接抛
 *      "too many SQL variables"; 就算没抛, 一条几千占位符的语句本身也很贵。
 *      现在候选先截断到 CANDIDATE_LIMIT, 且所有 IN 查询按 CHUNK_PARAMS 分片。
 *
 *   3. **每次搜索都全表扫一遍算 avgDocLen**。`SELECT AVG(LENGTH(content)) FROM chunks`
 *      在 224MB 库上是实打实的全表扫描, 而这个值几乎不变。现在算一次缓存在
 *      meta 表里, 写入路径失效它。
 */

import { parentPort } from 'worker_threads';
import { createRequire } from 'module';
import * as fs from 'fs';

import type {
  IndexChunkSymbol,
  IndexDbOp,
  IndexDbRequest,
  IndexPendingChunk,
  IndexSearchResult,
  IndexStatus,
} from '../services/indexDbTypes.js';

const _require = createRequire(import.meta.url);

/* 一条 SQL 里最多塞多少占位符 —— SQLite 上限 32766, 留足余量并且分片本身更快 */
const CHUNK_PARAMS = 500;
/* BM25 打分前先把候选截断 —— 一个常见词能命中上万 chunk, 全打分毫无意义 */
const CANDIDATE_LIMIT = 2000;

interface ChunkRow {
  id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  file_hash: string;
  indexed_at: number;
}

import { tokenize } from '../services/indexTokenize.js';

function isValidBM25Term(term: string, tfVal: number): boolean {
  return term.length > 0 && Number.isFinite(tfVal) && tfVal > 0;
}

/** 把一个大数组切成若干片, 每片不超过 CHUNK_PARAMS */
function* slices<T>(items: T[], size = CHUNK_PARAMS): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

// ─── DB ──────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any = null;

/**
 * 老版本的库里有 `embeddings` 表 (float32 向量 BLOB, 单库能到几百 MB)。索引早已
 * 改成纯本地 BM25, 那张表是纯死重 —— 探到就整库 unlink 重建 (BM25 重建纯 CPU,
 * 大仓库几十秒就回来)。
 */
function wipeLegacyDb(dbPath: string): boolean {
  const Database = _require('better-sqlite3');
  try {
    if (!fs.existsSync(dbPath)) return false;
    const probe = new Database(dbPath, { readonly: true });
    let legacy = false;
    try {
      const row = probe
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'")
        .get() as { name?: string } | undefined;
      legacy = row?.name === 'embeddings';
    } finally {
      try { probe.close(); } catch { /* noop */ }
    }
    if (!legacy) return false;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* 删不掉就让下面照常打开 */ }
    }
    return true;
  } catch {
    /* 探不动就算了 —— 下面照常打开, 大不了旧表继续躺着 */
    return false;
  }
}

function openDb(dbPath: string): void {
  closeDb();
  wipeLegacyDb(dbPath);
  const Database = _require('better-sqlite3');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  /* 索引库是**可重建的派生数据** —— 掉电丢最后几笔无所谓, 重扫一次就回来了。
   * 换 NORMAL 之后每笔事务不再强制 fsync, 这是写入路径上最大的一块常数。 */
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);

    CREATE TABLE IF NOT EXISTS bm25_terms (
      term TEXT NOT NULL,
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      tf REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bm25_terms ON bm25_terms(term);

    CREATE TABLE IF NOT EXISTS chunk_symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT,
      container_name TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_symbols_chunk ON chunk_symbols(chunk_id);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  /* 按 chunk_id 取 term 的路径以前没有索引 —— 它是搜索里被打得最狠的一条。
   * (term) 上的索引管不了这个方向。 */
  db.exec('CREATE INDEX IF NOT EXISTS idx_bm25_terms_chunk ON bm25_terms(chunk_id);');
  db.exec(`
    DELETE FROM bm25_terms WHERE chunk_id NOT IN (SELECT id FROM chunks);
    DELETE FROM chunk_symbols WHERE chunk_id NOT IN (SELECT id FROM chunks);
  `);
}

function closeDb(): void {
  if (!db) return;
  try { db.close(); } catch { /* 关不上也要把引用丢掉, 否则下次 open 会用到一个坏句柄 */ }
  db = null;
}

function requireDb(): any {
  if (!db) throw new Error('index db not open');
  return db;
}

// ─── 写 ──────────────────────────────────────────────────────────────────────

function deleteFiles(relPaths: string[]): void {
  if (relPaths.length === 0) return;
  const d = requireDb();
  const txn = d.transaction((paths: string[]) => {
    for (const part of slices(paths)) {
      d.prepare(`DELETE FROM chunks WHERE file_path IN (${part.map(() => '?').join(',')})`).run(...part);
    }
  });
  txn(relPaths);
  invalidateAvgDocLen();
}

function insertChunks(batch: IndexPendingChunk[]): number {
  if (batch.length === 0) return 0;
  const d = requireDb();
  const insertChunk = d.prepare(
    'INSERT INTO chunks (file_path, start_line, end_line, content, file_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertTerm = d.prepare('INSERT INTO bm25_terms (term, chunk_id, tf) VALUES (?, ?, ?)');
  const insertSymbol = d.prepare(
    'INSERT INTO chunk_symbols (chunk_id, name, kind, start_line, end_line, signature, container_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const now = Date.now();
  let inserted = 0;
  const txn = d.transaction((items: IndexPendingChunk[]) => {
    for (const c of items) {
      const res = insertChunk.run(c.filePath, c.startLine, c.endLine, c.text, c.hash, now);
      const chunkId = res.lastInsertRowid as number;
      inserted += 1;
      for (const entry of c.terms) {
        if (!isValidBM25Term(entry.term, entry.tf)) continue;
        insertTerm.run(entry.term, chunkId, entry.tf);
      }
      for (const symbol of c.relatedSymbols) {
        insertSymbol.run(
          chunkId, symbol.name, symbol.kind, symbol.startLine, symbol.endLine,
          symbol.signature ?? null, symbol.containerName ?? null,
        );
      }
    }
  });
  txn(batch);
  invalidateAvgDocLen();
  return inserted;
}

function clearAll(): void {
  const d = requireDb();
  const txn = d.transaction(() => {
    d.prepare('DELETE FROM bm25_terms').run();
    d.prepare('DELETE FROM chunk_symbols').run();
    d.prepare('DELETE FROM chunks').run();
    d.prepare('DELETE FROM meta').run();
  });
  txn();
}

// ─── 读 ──────────────────────────────────────────────────────────────────────

function listIndexedFiles(): string[] {
  return (requireDb()
    .prepare('SELECT DISTINCT file_path FROM chunks ORDER BY file_path ASC')
    .all() as Array<{ file_path: string }>)
    .map((row) => row.file_path);
}

function getFileHashes(relPaths: string[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (relPaths.length === 0) return out;
  const d = requireDb();
  for (const part of slices(relPaths)) {
    const rows = d.prepare(
      `SELECT file_path, MIN(file_hash) AS file_hash FROM chunks
        WHERE file_path IN (${part.map(() => '?').join(',')})
        GROUP BY file_path`,
    ).all(...part) as Array<{ file_path: string; file_hash: string }>;
    for (const row of rows) out[row.file_path] = row.file_hash;
  }
  return out;
}

const AVG_DOC_LEN_KEY = 'avg_doc_len';

function invalidateAvgDocLen(): void {
  try { requireDb().prepare('DELETE FROM meta WHERE key = ?').run(AVG_DOC_LEN_KEY); } catch { /* 缓存而已 */ }
}

function avgDocLen(): number {
  const d = requireDb();
  const cached = d.prepare('SELECT value FROM meta WHERE key = ?').get(AVG_DOC_LEN_KEY) as { value: string } | undefined;
  if (cached) {
    const n = Number(cached.value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const computed = (d.prepare('SELECT AVG(LENGTH(content)) AS avg FROM chunks').get() as { avg: number })?.avg || 1000;
  try { d.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(AVG_DOC_LEN_KEY, String(computed)); } catch { /* noop */ }
  return computed;
}

function loadSymbolsFor(chunkIds: number[]): Map<number, IndexChunkSymbol[]> {
  const out = new Map<number, IndexChunkSymbol[]>();
  if (chunkIds.length === 0) return out;
  const d = requireDb();
  for (const part of slices(chunkIds)) {
    const rows = d.prepare(
      `SELECT chunk_id, name, kind, start_line, end_line, signature, container_name
         FROM chunk_symbols WHERE chunk_id IN (${part.map(() => '?').join(',')})
        ORDER BY start_line ASC, end_line ASC`,
    ).all(...part) as Array<{
      chunk_id: number; name: string; kind: string;
      start_line: number; end_line: number; signature: string | null; container_name: string | null;
    }>;
    for (const row of rows) {
      const list = out.get(row.chunk_id) ?? [];
      list.push({
        name: row.name,
        kind: row.kind,
        startLine: row.start_line,
        endLine: row.end_line,
        signature: row.signature ?? undefined,
        containerName: row.container_name ?? undefined,
      });
      out.set(row.chunk_id, list);
    }
  }
  return out;
}

function collectSymbolCandidateIds(queryTokens: string[]): number[] {
  if (queryTokens.length === 0) return [];
  const d = requireDb();
  const clauses = queryTokens
    .map(() => "(LOWER(name) LIKE ? OR LOWER(COALESCE(container_name, '')) LIKE ? OR LOWER(COALESCE(signature, '')) LIKE ?)")
    .join(' OR ');
  const args = queryTokens.flatMap((token) => {
    const like = `%${token}%`;
    return [like, like, like];
  });
  /* LIKE '%x%' 用不上索引, 是全表扫 —— 加 LIMIT 让它不至于在大库上失控。
   * 符号候选只是给 BM25 结果加权的补充来源, 少几个不影响可用性。 */
  const rows = d.prepare(
    `SELECT DISTINCT chunk_id FROM chunk_symbols WHERE ${clauses} LIMIT ${CANDIDATE_LIMIT}`,
  ).all(...args) as Array<{ chunk_id: number }>;
  return rows.map((row) => row.chunk_id);
}

function computeSymbolBoost(queryTokens: string[], symbols: IndexChunkSymbol[]): number {
  if (queryTokens.length === 0 || symbols.length === 0) return 0;
  let boost = 0;
  for (const token of queryTokens) {
    if (symbols.some((s) => s.name.toLowerCase() === token)) { boost += 1.2; continue; }
    if (symbols.some((s) => s.name.toLowerCase().includes(token))) { boost += 0.7; continue; }
    if (symbols.some((s) => s.containerName?.toLowerCase().includes(token))) { boost += 0.35; continue; }
    if (symbols.some((s) => s.signature?.toLowerCase().includes(token))) boost += 0.2;
  }
  return Math.min(boost, 2.5);
}

function search(query: string, topK: number): IndexSearchResult[] {
  const d = requireDb();
  const queryTokens = Array.from(new Set(tokenize(query)));
  const symbolIds = collectSymbolCandidateIds(queryTokens);

  let termIds: number[] = [];
  if (queryTokens.length > 0) {
    /* 候选按命中词数排序再截断 —— 直接 LIMIT 会随机丢掉最相关的那些 */
    const rows = d.prepare(
      `SELECT chunk_id, COUNT(DISTINCT term) AS hits
         FROM bm25_terms WHERE term IN (${queryTokens.map(() => '?').join(',')})
        GROUP BY chunk_id ORDER BY hits DESC LIMIT ${CANDIDATE_LIMIT}`,
    ).all(...queryTokens) as Array<{ chunk_id: number }>;
    termIds = rows.map((row) => row.chunk_id);
  }

  const candidateIds = Array.from(new Set([...termIds, ...symbolIds])).slice(0, CANDIDATE_LIMIT);
  if (candidateIds.length === 0) return [];

  const chunks: ChunkRow[] = [];
  for (const part of slices(candidateIds)) {
    chunks.push(...(d.prepare(
      `SELECT * FROM chunks WHERE id IN (${part.map(() => '?').join(',')})`,
    ).all(...part) as ChunkRow[]));
  }
  if (chunks.length === 0) return [];

  /* tf 一次取回 —— 只要查询词的, 只要候选 chunk 的 (老实现是每个 chunk 打一次全量) */
  const tfByChunk = new Map<number, Record<string, number>>();
  if (queryTokens.length > 0) {
    const ids = chunks.map((c) => c.id);
    for (const part of slices(ids)) {
      const rows = d.prepare(
        `SELECT chunk_id, term, tf FROM bm25_terms
          WHERE chunk_id IN (${part.map(() => '?').join(',')})
            AND term IN (${queryTokens.map(() => '?').join(',')})`,
      ).all(...part, ...queryTokens) as Array<{ chunk_id: number; term: string; tf: number }>;
      for (const row of rows) {
        const map = tfByChunk.get(row.chunk_id) ?? {};
        map[row.term] = row.tf;
        tfByChunk.set(row.chunk_id, map);
      }
    }
  }

  const k1 = 1.5;
  const b = 0.75;
  const avg = avgDocLen();
  const scored = chunks.map((chunk) => {
    const tfMap = tfByChunk.get(chunk.id) ?? {};
    const docLen = chunk.content.length;
    let score = 0;
    for (const term of queryTokens) {
      const tf = tfMap[term] || 0;
      if (tf === 0) continue;
      score += (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avg)));
    }
    return { chunk, score };
  });
  scored.sort((left, right) => right.score - left.score);

  const shortlist = scored.slice(0, Math.max(topK * 5, 20));
  const symbolsById = loadSymbolsFor(shortlist.map((entry) => entry.chunk.id));
  return shortlist
    .map(({ chunk, score }) => {
      const relatedSymbols = symbolsById.get(chunk.id) ?? [];
      return {
        file: chunk.file_path,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        content: chunk.content,
        score: score + computeSymbolBoost(queryTokens, relatedSymbols),
        relatedSymbols,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

function status(): IndexStatus {
  try {
    const d = requireDb();
    const fileCount = (d.prepare('SELECT COUNT(DISTINCT file_path) AS n FROM chunks').get() as { n: number })?.n ?? 0;
    const chunkCount = (d.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number })?.n ?? 0;
    const row = d.prepare("SELECT value FROM meta WHERE key = 'last_built'").get() as { value: string } | undefined;
    return { fileCount, chunkCount, lastBuilt: row ? Number(row.value) : null };
  } catch {
    return { fileCount: 0, chunkCount: 0, lastBuilt: null };
  }
}

// ─── 派发 ────────────────────────────────────────────────────────────────────

function handle(payload: IndexDbOp): unknown {
  switch (payload.op) {
    case 'open': openDb(payload.dbPath); return true;
    case 'close': closeDb(); return true;
    case 'listIndexedFiles': return listIndexedFiles();
    case 'getFileHashes': return getFileHashes(payload.relPaths);
    case 'deleteFiles': deleteFiles(payload.relPaths); return true;
    case 'insertChunks': return insertChunks(payload.batch);
    case 'setMeta':
      requireDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(payload.key, payload.value);
      return true;
    case 'search': return search(payload.query, payload.topK);
    case 'status': return status();
    case 'clear': clearAll(); return true;
    default:
      throw new Error(`unsupported index db op: ${(payload as { op?: string }).op ?? 'unknown'}`);
  }
}

parentPort?.on('message', (message: IndexDbRequest) => {
  try {
    parentPort?.postMessage({ id: message.id, ok: true, result: handle(message.payload) });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
