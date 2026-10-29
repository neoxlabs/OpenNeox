import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface PersistedReadEntry {
  rangeKey: string;
  content: string;
  startLine: number;
  lineCount: number;
  mtimeMs: number;
  sizeBytes: number;
  readAtTurn: number;
}

export interface PersistedSessionLedger {
  version: 1;
  sessionId: string;
  savedAt: string;
  /** normPath → 该文件的读记录 */
  files: Record<string, PersistedReadEntry[]>;
}

/** 单条内容上限 —— 超了整条丢弃 (见文件头"安全边界") */
const MAX_ENTRY_CONTENT_CHARS = 256 * 1024;
/** 单会话文件数上限 */
const MAX_FILES = 300;
/** 落盘文件体积上限 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** 落盘防抖 */
const PERSIST_DEBOUNCE_MS = 300;
/** 版本戳 -1 = HISTORY_SEEN 占位 (见 readLedger.ts), 没有内容也无所谓 */
const PLACEHOLDER_MTIME = -1;

const pendingTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; produce: () => Record<string, PersistedReadEntry[]> }>();

function ledgerDir(): string {
  const override = process.env.NEOX_READ_LEDGER_DIR?.trim();
  if (override) return override;
  return neoxHome('cache', 'read-ledger');
}

/** sessionId → 稳定且文件名安全的 key (原名可能含 / : 等字符) */
export function ledgerPathForSession(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const hash = createHash('sha1').update(sessionId).digest('hex').slice(0, 8);
  return path.join(ledgerDir(), `${safe}-${hash}.json`);
}

/** 去掉空文件 / 超限条目, 按文件数与体积上限裁剪。返回 null = 没什么可存的。 */
function trimSnapshot(files: Record<string, PersistedReadEntry[]>): Record<string, PersistedReadEntry[]> | null {
  const kept: Array<[string, PersistedReadEntry[]]> = [];
  for (const [normPath, entries] of Object.entries(files)) {
    const usable = entries.filter((e) => {
      if (!e || typeof e.rangeKey !== 'string') return false;
      if (e.mtimeMs === PLACEHOLDER_MTIME) return true;
      /* 内容超限 → 整条丢 (只留版本戳会让 readfile 去重返回空 stub) */
      return typeof e.content === 'string' && e.content.length <= MAX_ENTRY_CONTENT_CHARS;
    });
    if (usable.length > 0) kept.push([normPath, usable]);
  }
  if (kept.length === 0) return null;

  /* 新的在前, 超过文件数上限时丢最旧的 (readAtTurn 最大的保留) */
  const newestTurn = (list: PersistedReadEntry[]): number =>
    list.reduce((max, e) => Math.max(max, e.readAtTurn || 0), 0);
  kept.sort((a, b) => newestTurn(b[1]) - newestTurn(a[1]));
  const limited = kept.slice(0, MAX_FILES);

  const out: Record<string, PersistedReadEntry[]> = {};
  let bytes = 0;
  for (const [normPath, entries] of limited) {
    const entryBytes = entries.reduce((n, e) => n + (e.content?.length ?? 0) + 128, 0) + normPath.length;
    if (bytes + entryBytes > MAX_FILE_BYTES) continue;
    bytes += entryBytes;
    out[normPath] = entries;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 同步落盘 (原子: 先写 .tmp 再 rename)。失败只记 debug, 绝不影响主流程。 */
export function persistNow(sessionId: string, files: Record<string, PersistedReadEntry[]>): void {
  try {
    const trimmed = trimSnapshot(files);
    if (!trimmed) return;
    const target = ledgerPathForSession(sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const payload: PersistedSessionLedger = {
      version: 1,
      sessionId,
      savedAt: new Date().toISOString(),
      files: trimmed,
    };
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err: any) {
    cliLogger.debug('LEDGER', `落盘读账本失败 (不影响会话): ${err?.message ?? err}`);
  }
}

/** 防抖落盘 —— 同一会话 300ms 内的多次写只落一次。 */
export function schedulePersist(sessionId: string, files: () => Record<string, PersistedReadEntry[]>): void {
  const existing = pendingTimers.get(sessionId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingTimers.delete(sessionId);
    persistNow(sessionId, files());
  }, PERSIST_DEBOUNCE_MS);
  /* 绝不能因为一个落盘定时器拖住进程退出 */
  (timer as any).unref?.();
  pendingTimers.set(sessionId, { timer, produce: files });
}

/**
 * 立刻把待落盘写下去 —— session 结束 / 测试 / 进程退出前用。
 * 无参 = 全部待落盘会话。返回实际写了几个。
 */
export function flushPending(sessionId?: string): number {
  const ids = sessionId ? [sessionId] : [...pendingTimers.keys()];
  let flushed = 0;
  for (const id of ids) {
    const pending = pendingTimers.get(id);
    if (!pending) continue;
    clearTimeout(pending.timer);
    pendingTimers.delete(id);
    try {
      persistNow(id, pending.produce());
      flushed++;
    } catch {
      /* 落盘失败不影响任何东西 */
    }
  }
  return flushed;
}

/**
 * 读回某个会话的账本, 并逐条用 stat 校验版本戳。
 * 文件不存在 / 损坏 / 版本不对 → null (退化成老行为: 从历史重建或 unread)。
 */
export function loadPersisted(sessionId: string): Record<string, PersistedReadEntry[]> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(ledgerPathForSession(sessionId), 'utf-8');
  } catch {
    return null;   // 没落过盘 = 正常
  }
  let parsed: PersistedSessionLedger;
  try {
    parsed = JSON.parse(raw) as PersistedSessionLedger;
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== 1 || !parsed.files || typeof parsed.files !== 'object') return null;

  const out: Record<string, PersistedReadEntry[]> = {};
  let keptEntries = 0;
  let droppedEntries = 0;
  for (const [normPath, entries] of Object.entries(parsed.files)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(normPath);
      if (!st.isFile()) { droppedEntries += entries.length; continue; }
    } catch {
      droppedEntries += entries.length;   // 文件删了 / 挪走了 → 这条证据没意义
      continue;
    }
    const fresh = entries.filter((e) => {
      if (!e || typeof e.rangeKey !== 'string') return false;
      if (e.mtimeMs === PLACEHOLDER_MTIME) return true;   // HISTORY_SEEN: 永不命中, 只改诊断
      return e.mtimeMs === st.mtimeMs && e.sizeBytes === st.size;
    });
    droppedEntries += entries.length - fresh.length;
    if (fresh.length > 0) {
      out[normPath] = fresh;
      keptEntries += fresh.length;
    }
  }
  cliLogger.debug('LEDGER', `读账本落盘恢复: 保留 ${keptEntries} 条, 丢弃 ${droppedEntries} 条 (文件已变/已删)`);
  return Object.keys(out).length > 0 ? out : null;
}

/** session 结束: 删掉落盘文件 (会话都没了, 账本不该留着)。 */
export function deletePersisted(sessionId: string): void {
  const pending = pendingTimers.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingTimers.delete(sessionId);
  }
  try {
    fs.rmSync(ledgerPathForSession(sessionId), { force: true });
  } catch {
    /* 删不掉不影响任何东西 */
  }
}
