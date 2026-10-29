/**
 * 从 CLI 的 SQLite 里读一次运行的真实用量。
 *
 * 为什么读库: `neox -p --json` 只输出 `{result, error}` (apps/cli/src/bootstrap/printMode.ts),
 * 没有 usage 字段。用量写在 `agent_turn_metrics` 表 (packages/core/src/runtime/agentMetricsCollector.ts
 * 在 run_done 时 flush)。bench 给每个 run 设独立的 NEOX_DB_PATH, 库里就只有这一次运行的行,
 * 不用按 session id 猜。
 *
 * 读不到就全给 null —— 缺指标比编指标好。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const NULL_METRICS = Object.freeze({
  source: null,
  modelRequests: null,
  toolCalls: null,
  toolFailures: null,
  inputTokens: null,
  cacheHitTokens: null,
  outputTokens: null,
  firstTokenMs: null,
  agentDurationMs: null,
});

let sqliteModule;

/** node:sqlite 在 Node 22 会打一条 ExperimentalWarning, 别让它污染报告输出 */
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

function openReadonly(DatabaseSync, dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** 只读打开可能撞上未 checkpoint 的 WAL / 权限问题 —— 兜底复制一份快照再读 */
function snapshotCopy(dbPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bench-db-'));
  const target = path.join(dir, 'snapshot.db');
  fs.copyFileSync(dbPath, target);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, target + suffix);
  }
  return target;
}

function sum(rows, key) {
  let total = null;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== 'number') continue;
    total = (total ?? 0) + value;
  }
  return total;
}

function readLastRequestUsage(db) {
  const row = db
    .prepare('SELECT latest_request_usage FROM sessions WHERE latest_request_usage IS NOT NULL ORDER BY updated_at DESC LIMIT 1')
    .get();
  if (!row?.latest_request_usage) return null;
  try {
    return JSON.parse(row.latest_request_usage);
  } catch {
    return null;
  }
}

function addMaybe(base, extra) {
  if (typeof extra !== 'number') return base;
  return (base ?? 0) + extra;
}

/**
 * @param {string} dbPath 该次 run 的 NEOX_DB_PATH
 * @returns {Promise<typeof NULL_METRICS>}
 */
export async function readRunMetrics(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return { ...NULL_METRICS };
  const sqlite = await loadSqlite();
  if (!sqlite) return { ...NULL_METRICS };

  let db;
  let openedPath = dbPath;
  try {
    db = openReadonly(sqlite.DatabaseSync, dbPath);
  } catch {
    try {
      openedPath = snapshotCopy(dbPath);
      db = openReadonly(sqlite.DatabaseSync, openedPath);
    } catch {
      return { ...NULL_METRICS };
    }
  }

  try {
    let rows = [];
    try {
      rows = db
        .prepare(
          'SELECT inferences, tool_calls, tool_failures, ttfa_ms, duration_ms, input_tokens, output_tokens, cache_read_tokens, timestamp ' +
            'FROM agent_turn_metrics ORDER BY timestamp',
        )
        .all();
    } catch {
      rows = [];
    }

    // `agent_turn_metrics` 的 token 是「上一次请求结算」时写入的: 最后一个请求
    // 没有下一次边界, 所以永远不在表里。真实用量的最后一段在 sessions.latest_request_usage。
    // 两者相加才是整次运行 (单请求的 chat 里表里全是 0, 只有后者有值)。
    const lastRequest = readLastRequestUsage(db);

    if (!rows.length) {
      if (!lastRequest) return { ...NULL_METRICS };
      return {
        ...NULL_METRICS,
        source: 'sessions.latest_request_usage',
        inputTokens: lastRequest.inputTokens ?? null,
        cacheHitTokens: lastRequest.cacheReadTokens ?? null,
        outputTokens: lastRequest.outputTokens ?? null,
      };
    }

    return {
      source: lastRequest ? 'agent_turn_metrics + sessions.latest_request_usage' : 'agent_turn_metrics',
      modelRequests: sum(rows, 'inferences'),
      toolCalls: sum(rows, 'tool_calls'),
      toolFailures: sum(rows, 'tool_failures'),
      inputTokens: addMaybe(sum(rows, 'input_tokens'), lastRequest?.inputTokens),
      cacheHitTokens: addMaybe(sum(rows, 'cache_read_tokens'), lastRequest?.cacheReadTokens),
      outputTokens: addMaybe(sum(rows, 'output_tokens'), lastRequest?.outputTokens),
      firstTokenMs: rows[0].ttfa_ms ?? null,
      agentDurationMs: sum(rows, 'duration_ms'),
    };
  } finally {
    try {
      db.close();
    } catch {
      /* 关不掉不影响结论 */
    }
  }
}
