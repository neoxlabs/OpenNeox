/**
 * 读一次 run 的会话库, 回答「模型到底调了哪些工具」。
 *
 * 判分只看磁盘真相: 回答里写了「我搜索了」不算, messages 表里出现 tool call 才算。
 * NEOX_DB_ENCRYPT=0 由跑分器设置, 这里用 node:sqlite 只读打开 (先复制快照, 避开 WAL)。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let sqliteModule;

async function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const message = typeof warning === 'string' ? warning : (warning?.message ?? '');
    if (/SQLite is an experimental feature/i.test(message)) return;
    return originalEmitWarning.call(process, warning, ...rest);
  };
  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  return sqliteModule;
}

/** 该次 run 的 messages 原文 (JSON 行拼起来的字符串); 读不到返回 '' */
export async function readMessageLog(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return '';
  const sqlite = await loadSqlite();
  if (!sqlite) return '';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bench-log-'));
  const snapshot = path.join(dir, 'snapshot.db');
  try {
    fs.copyFileSync(dbPath, snapshot);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, snapshot + suffix);
    }
    const db = new sqlite.DatabaseSync(snapshot, { readOnly: true });
    try {
      const rows = db.prepare('SELECT item_data FROM messages ORDER BY seq').all();
      return rows.map((row) => String(row.item_data ?? '')).join('\n');
    } finally {
      try { db.close(); } catch { /* 关不掉不影响判分 */ }
    }
  } catch {
    return '';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function calledTools(dbPath) {
  const log = await readMessageLog(dbPath);
  const names = new Set();
  for (const match of log.matchAll(/"name"\s*:\s*"([a-z_]+)"/g)) names.add(match[1]);
  return names;
}
