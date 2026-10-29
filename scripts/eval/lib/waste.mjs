/**
 * 白跑轮次分类统计 (code:EVAL-04) —— 从一次 run 的会话库里数四类浪费。
 *
 * 为什么离线算: 会话库 (messages 表) 里有完整的工具调用参数、工具结果和压缩快照,
 * 跑完以后复盘即可, 不需要在热路径上再加埋点。口径写在这里, 报告和测试读同一份。
 *
 * 四类 (互不重叠的计数, 单位写明):
 *   重读      re-read: 同一个文件在没有写入的情况下又被读了一次 (call 数 + 命中轮数)
 *   穷举      exhaustive: 同一个工具在同一路径上第 3 次及以后调用, 或参数完全相同的重复调用
 *                        (换了参数打转 / 原地重试)。call 数 + 轮数。
 *   空转      idle: 模型输出了一条没有工具调用的消息, 之后还会继续跑 (runner 续跑的轮次)。
 *                 有 agent_turn_metrics.waste_json 时优先用它 (noToolGuardFollowups 等),
 *                 否则退回消息日志推断。轮数。
 *   压缩后重读 reread-after-compaction: 文件在最近一次压缩 (compaction_snapshot) 之前读过,
 *                 压缩之后又读。与「重读」分开计, 不重复计入。call 数 + 轮数。
 *
 * 判不出来的都记 0, 不编数字。读取不到库时 source=null。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const READ_TOOLS = new Set(['readfile', 'read_file', 'read', 'view_file']);
const WRITE_TOOLS = new Set(['edit', 'edit_file', 'edit_batch', 'write_file', 'write', 'multi_edit', 'apply_patch']);
const SEARCH_TOOLS = new Set(['search', 'grep', 'glob', 'search_files', 'list_directory', 'show_tree', 'tool_search']);
const SHELL_TOOLS = new Set(['execute_shell', 'bash', 'run_command']);

const COMPACTION_ITEM_TYPE = 'compaction_snapshot';

/** 参数里的目标路径 —— 各家工具叫法不同, 取第一个存在的 */
export function targetPath(args) {
  if (!args || typeof args !== 'object') return '';
  const raw = args.file_path ?? args.path ?? args.directory ?? args.dir ?? args.target_file;
  if (typeof raw === 'string' && raw.trim()) return normalizePath(raw);
  const list = args.paths ?? args.files;
  if (Array.isArray(list) && list.length && typeof list[0] === 'string') return normalizePath(list[0]);
  return '';
}

/** 一次调用涉及的所有路径 (edit_batch / write_file files=[...] 会一次改多个) */
export function targetPaths(args) {
  if (!args || typeof args !== 'object') return [];
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) out.push(normalizePath(value));
  };
  push(args.file_path);
  push(args.path);
  push(args.directory);
  push(args.dir);
  push(args.target_file);
  for (const list of [args.paths, args.files]) {
    if (Array.isArray(list)) list.forEach(push);
  }
  if (Array.isArray(args.edits)) {
    for (const entry of args.edits) push(entry?.file_path);
  }
  return [...new Set(out)];
}

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '') || String(value);
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 参数规范化 (排序 key) —— 用于判断「参数完全相同的重复调用」 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function callSignature(name, args) {
  return `${name}|${stableStringify(args ?? {})}`;
}

/** 搜索族的分组键: 同一工具 + 同一搜索根 = 在一片区域里打转 */
function searchGroupKey(name, args) {
  const root = targetPath(args) || 'cwd';
  return `${name}|${root}`;
}

/** shell 分组键: 只看命令前两个 token (node scripts/x.mjs vs node scripts/y.mjs 算同一类) */
function shellGroupKey(name, args) {
  const command = typeof args?.command === 'string' ? args.command.trim() : '';
  const head = command.split(/\s+/).slice(0, 2).join(' ');
  return `${name}|${head}`;
}

/**
 * 把 messages 行整理成「按时间排序的调用序列 + 压缩事件」。
 * 入参形状与 DB 一致: [{ seq, itemType, itemData }]，itemData 为解析后的对象。
 */
export function extractCalls(items) {
  const turns = [];
  const calls = [];
  const results = new Map();
  let compactionCount = 0;
  let currentTurn = -1;

  for (const item of items ?? []) {
    const type = item?.itemType ?? item?.item_type ?? 'message';
    if (type === COMPACTION_ITEM_TYPE) {
      compactionCount += 1;
      continue;
    }
    const data = item?.itemData ?? item?.item_data ?? {};
    const raw = data?.raw ?? data;
    const role = raw?.role ?? data?.role;
    if (role === 'assistant') {
      currentTurn += 1;
      const toolCalls = Array.isArray(raw?.tool_calls) ? raw.tool_calls : [];
      turns.push({ index: currentTurn, toolCount: toolCalls.length });
      for (const call of toolCalls) {
        const name = String(call?.function?.name ?? call?.name ?? '');
        if (!name) continue;
        calls.push({
          turn: currentTurn,
          seq: item?.seq ?? 0,
          name,
          args: parseArgs(call?.function?.arguments ?? call?.arguments),
          compactionEpoch: compactionCount,
          callId: String(call?.id ?? ''),
        });
      }
    } else if (role === 'tool') {
      const callId = String(raw?.tool_call_id ?? data?.tool_call_id ?? '');
      const content = typeof data?.content === 'string' ? data.content : raw?.content;
      if (callId && typeof content === 'string') results.set(callId, content);
    }
  }

  return { turns, calls, results, compactions: compactionCount };
}

/**
 * 纯分类函数 (无 IO, 单测直接调用)。
 *
 * @param {{turns: Array<{index:number, toolCount:number}>, calls: Array<any>, compactions: number}} trace
 * @param {{idleTurns?: number}} [runtime] agent_turn_metrics.waste_json 汇总出的空转轮数
 */
export function classifyWaste(trace, runtime = {}) {
  const turns = trace?.turns ?? [];
  const calls = trace?.calls ?? [];

  /* 每个文件最后一次被读的时刻 (序号 + 压缩代次); 写入会清掉 */
  const lastRead = new Map();
  const rereadTurns = new Set();
  const compactRereadTurns = new Set();
  const exhaustiveTurns = new Set();
  let rereadCalls = 0;
  let compactRereadCalls = 0;
  let exhaustiveCalls = 0;

  const searchGroupCounts = new Map();
  const shellGroupCounts = new Map();
  const seenSignatures = new Set();

  for (const call of calls) {
    const name = call.name;
    const args = call.args ?? {};

    if (WRITE_TOOLS.has(name)) {
      for (const p of targetPaths(args)) lastRead.delete(p);
      continue;
    }

    if (READ_TOOLS.has(name)) {
      for (const p of targetPaths(args)) {
        const previous = lastRead.get(p);
        if (previous) {
          if (previous.compactionEpoch < call.compactionEpoch) {
            compactRereadCalls += 1;
            compactRereadTurns.add(call.turn);
          } else {
            rereadCalls += 1;
            rereadTurns.add(call.turn);
          }
        }
        lastRead.set(p, { seq: call.seq, compactionEpoch: call.compactionEpoch });
      }
      continue;
    }

    if (SEARCH_TOOLS.has(name) || SHELL_TOOLS.has(name)) {
      const isSearch = SEARCH_TOOLS.has(name);
      const groupKey = isSearch ? searchGroupKey(name, args) : shellGroupKey(name, args);
      const groups = isSearch ? searchGroupCounts : shellGroupCounts;
      const signature = callSignature(name, args);
      const count = (groups.get(groupKey) ?? 0) + 1;
      groups.set(groupKey, count);

      const exactRepeat = seenSignatures.has(signature);
      seenSignatures.add(signature);
      if (exactRepeat || count >= 3) {
        exhaustiveCalls += 1;
        exhaustiveTurns.add(call.turn);
      }
    }
  }

  /* 空转: 有 runner 的 loopWasteStats 就直接用；没有就从消息日志推断
   * (没有工具调用、且后面还有 assistant 消息 = 被续跑的轮次; 最后一条是收尾回答)。 */
  const messageIdleTurns = new Set();
  for (const turn of turns) {
    if (turn.toolCount === 0 && turn.index < turns.length - 1) messageIdleTurns.add(turn.index);
  }
  const idleFromRuntime = Number.isFinite(runtime?.idleTurns) && runtime.idleTurns > 0;
  const idleTurns = idleFromRuntime ? runtime.idleTurns : messageIdleTurns.size;

  const wasteTurnUnion = new Set([
    ...rereadTurns,
    ...compactRereadTurns,
    ...exhaustiveTurns,
    ...messageIdleTurns,
  ]);
  /* runner 口径的空转轮次不一定能在消息日志里对上具体某轮, 按轮数计入总数 */
  const idleExtra = idleFromRuntime ? Math.max(0, idleTurns - messageIdleTurns.size) : 0;

  return {
    turns: turns.length,
    toolCalls: calls.length,
    compactions: trace?.compactions ?? 0,
    buckets: {
      reread: { turns: rereadTurns.size, calls: rereadCalls },
      exhaustive: { turns: exhaustiveTurns.size, calls: exhaustiveCalls },
      idle: { turns: idleTurns },
      rereadAfterCompact: { turns: compactRereadTurns.size, calls: compactRereadCalls },
    },
    wasteTurns: wasteTurnUnion.size + idleExtra,
    wasteRate: turns.length ? Number(((wasteTurnUnion.size + idleExtra) / turns.length).toFixed(3)) : 0,
    idleSource: idleFromRuntime ? 'waste_json' : 'messages',
  };
}

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

function sumWasteIdle(db) {
  try {
    const rows = db.prepare('SELECT waste_json FROM agent_turn_metrics WHERE waste_json IS NOT NULL').all();
    let total = null;
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(String(row.waste_json)); } catch { continue; }
      const noTool = Number(parsed?.noToolGuardFollowups) || 0;
      const finalize = Number(parsed?.noToolFinalizeContinues) || 0;
      const gate = Number(parsed?.progressGateTriggers) || 0;
      total = (total ?? 0) + noTool + finalize + gate;
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * 读一次 run 的会话库, 出四类白跑统计。
 * @param {string} dbPath 该次 run 的 NEOX_DB_PATH
 */
export async function readWasteStats(dbPath) {
  const empty = classifyWaste({ turns: [], calls: [], compactions: 0 });
  if (!dbPath || !fs.existsSync(dbPath)) return { ...empty, source: null };
  const sqlite = await loadSqlite();
  if (!sqlite) return { ...empty, source: null };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bench-waste-'));
  const snapshot = path.join(dir, 'snapshot.db');
  try {
    fs.copyFileSync(dbPath, snapshot);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, snapshot + suffix);
    }
    const db = new sqlite.DatabaseSync(snapshot, { readOnly: true });
    try {
      const rows = db.prepare('SELECT seq, item_type, item_data FROM messages ORDER BY seq').all();
      const items = rows.map((row) => {
        let itemData = {};
        try { itemData = JSON.parse(String(row.item_data)); } catch { /* 坏行忽略 */ }
        return { seq: row.seq, itemType: row.item_type, itemData };
      });
      const trace = extractCalls(items);
      const idleTurns = sumWasteIdle(db);
      const result = classifyWaste(trace, { idleTurns: idleTurns ?? undefined });
      return { ...result, source: idleTurns === null ? 'messages' : 'messages + agent_turn_metrics.waste_json' };
    } finally {
      try { db.close(); } catch { /* 关不掉不影响统计 */ }
    }
  } catch {
    return { ...empty, source: null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 报告里展示用的四类标签 (顺序固定) */
export const WASTE_BUCKETS = [
  { key: 'reread', label: '重读' },
  { key: 'exhaustive', label: '穷举' },
  { key: 'idle', label: '空转' },
  { key: 'rereadAfterCompact', label: '压缩后重读' },
];
