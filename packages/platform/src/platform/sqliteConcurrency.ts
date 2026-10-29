
/** 等锁上限。跨进程写同一行时 5s 足够排队; 再长会让 UI 那侧看起来像卡死。 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** busy_timeout 用尽后的最后一层退避 (毫秒) —— 只有两次, 且每次都会打日志。 */
export const SQLITE_BUSY_RETRY_DELAYS_MS: readonly number[] = [100, 300];

export interface SqliteLike {
  exec(sql: string): unknown;
  /** better-sqlite3 / bun 兼容层有; node:sqlite 没有 (走 exec) */
  pragma?(source: string): unknown;
  transaction?(fn: () => unknown): unknown;
  /** better-sqlite3: inTransaction; node:sqlite: isTransaction */
  inTransaction?: boolean;
  isTransaction?: boolean;
}

export interface SqliteConcurrencyOptions {
  /** 默认 true。设 false 只设 busy_timeout / synchronous (例如只读连接)。 */
  wal?: boolean;
  /** 默认 true (WAL 下的常规取值)。 */
  synchronous?: boolean;
  busyTimeoutMs?: number;
}

export interface SqliteBusyRetryInfo {
  label: string;
  /** 第几次重试, 从 1 开始 */
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface ImmediateTransactionOptions {
  /** 日志里用来认位置 (例如 "session.appendMessage")。 */
  label?: string;
  /** 覆盖默认退避; 传 [] 表示不重试 (测试里用来证明 busy_timeout 本身够用)。 */
  retryDelaysMs?: readonly number[];
  /** 默认 console.warn; 测试/上层日志系统可替换。 */
  onBusyRetry?: (info: SqliteBusyRetryInfo) => void;
}

/** SQLITE_BUSY / SQLITE_LOCKED 的各种形态 (better-sqlite3 给 code + message)。 */
export function isSqliteBusyError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof e?.code === 'string' ? e.code.toUpperCase() : '';
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return true;
  const msg = String(e?.message ?? err ?? '');
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(msg);
}

export function applySqliteBusyTimeout(db: SqliteLike, timeoutMs: number = SQLITE_BUSY_TIMEOUT_MS): void {
  try {
    if (typeof db.pragma === 'function') db.pragma(`busy_timeout = ${timeoutMs}`);
    else db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
  } catch {
    /* 老驱动 / 特殊包装不支持 —— 非致命, 上层还有重试兜底 */
  }
}

/**
 * 统一连接策略: busy_timeout + WAL + synchronous=NORMAL。
 * 加密库必须先 PRAGMA key 再调用 (journal_mode 会读库头)。
 * 这里不吞 journal_mode 的错 —— 主库设不成 WAL 应该让启动路径知道。
 */
export function applySqliteConcurrencyPragmas(
  db: SqliteLike,
  opts: SqliteConcurrencyOptions = {},
): void {
  applySqliteBusyTimeout(db, opts.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS);
  if (opts.wal !== false) setPragma(db, 'journal_mode = WAL');
  if (opts.synchronous !== false) setPragma(db, 'synchronous = NORMAL');
}

/**
 * 写事务统一入口 —— BEGIN IMMEDIATE (有 .immediate() 用驱动的, 否则手工 BEGIN IMMEDIATE)。
 *
 * 为什么不是 deferred: 见文件头第 2 条。为什么不是简单加长 busy_timeout: 锁升级
 * (SQLITE_BUSY_SNAPSHOT) 不会走 busy handler, 等多久都没用。
 *
 * 重试安全性: 事务提交前抛错时 SQLite 已回滚, 重跑整段是幂等的。已在事务里 (嵌套调用)
 * 时不再开新事务, 也不重试 —— 交给外层事务保证原子性。
 */
export function runImmediateTransaction<T>(
  db: SqliteLike,
  fn: () => T,
  opts: ImmediateTransactionOptions = {},
): T {
  const label = opts.label ?? 'sqlite-immediate-tx';

  const txFactory = db.transaction;
  if (typeof txFactory === 'function') {
    const tx = txFactory.call(db, fn) as { immediate?: () => T } | null | undefined;
    if (tx && typeof tx.immediate === 'function') {
      return withBusyRetry(() => tx.immediate!(), label, opts);
    }
  }

  /* 驱动没有 transaction() (node:sqlite) 或没有 .immediate (老 bun): 手工开.
   * 已在事务里时不重复 BEGIN —— 嵌套由外层负责。 */
  if (isInTransaction(db)) return fn();
  return withBusyRetry(() => runManualImmediate(db, fn), label, opts);
}

function isInTransaction(db: SqliteLike): boolean {
  return db.inTransaction === true || db.isTransaction === true;
}

function setPragma(db: SqliteLike, source: string): void {
  if (typeof db.pragma === 'function') db.pragma(source);
  else db.exec(`PRAGMA ${source}`);
}

function runManualImmediate<T>(db: SqliteLike, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = fn();
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 / 连接坏了 */ }
    throw err;
  }
  try {
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw err;
  }
  return result;
}

function withBusyRetry<T>(
  run: () => T,
  label: string,
  opts: ImmediateTransactionOptions,
): T {
  const retryDelays = opts.retryDelaysMs ?? SQLITE_BUSY_RETRY_DELAYS_MS;
  let attempt = 0;
  for (;;) {
    try {
      return run();
    } catch (err) {
      if (attempt >= retryDelays.length || !isSqliteBusyError(err)) throw err;
      const delayMs = retryDelays[attempt];
      attempt += 1;
      const info: SqliteBusyRetryInfo = { label, attempt, delayMs, error: err };
      try {
        (opts.onBusyRetry ?? logBusyRetry)(info);
      } catch { /* 日志失败不影响重试 */ }
      sleepSync(delayMs);
    }
  }
}

function logBusyRetry(info: SqliteBusyRetryInfo): void {
  const msg = info.error instanceof Error ? info.error.message : String(info.error);
  console.warn(
    `[sqlite] ${info.label}: busy_timeout exhausted, retry ${info.attempt} after ${info.delayMs}ms — ${msg}`,
  );
}

function sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* 无 SharedArrayBuffer 的环境: 忙等 (罕见) */ }
  }
}
