/**
 * uiTrace — CLI **界面层**的常开取证日志。
 *
 * 路径: ~/.neox/logs/ui-trace.log  (JSONL, 常开, 自动轮转)
 *
 * ## 为什么要单独有它
 * `tool-trace.log` 记的是后端: 工具调了什么、LLM 收到什么。但用户实际报的一大类问题是**界面**的:
 *   · "turn 明明结束了, 状态栏还在转 Shell running..."   → 谁最后把 isRunning 设成 true 的?
 *   · "一次 edit 渲了两张卡"                             → 到底 addEntry 了几次, 各来自哪条通道?
 *   · "底部这块被截断/盖住了"                            → 当时 rows/cols 和各区块状态是什么?
 * 这些在 tool-trace 里一个字都看不到 —— 后端全对, 错在 UI 通道。所以这里只记 UI 状态迁移,
 * 不记内容正文 (预览一律 clip), 量小、常开、事后可查。
 *
 * ## 常开的理由
 * 跟 stall.log 同一条道理: 出问题的时候用户不可能预先开着 CLI_DEBUG=1。要它有用就必须默认写。
 * 代价控制: 每条记录都是短 JSON, 单文件上限 8MB, 满了转 .old (最多两代 16MB)。
 */

import * as fs from 'node:fs';
import { isDiagLogEnabled, isCliDebugFlagPresent } from '@neoxlabs/kernel/platform/diagLogGate.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

function resolveLogPath(): string {
  try {
    const dir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
    return path.join(dir, 'ui-trace.log');
  } catch {
    return '/tmp/neox-ui-trace.log';
  }
}

const UI_TRACE_PATH = resolveLogPath();
const MAX_BYTES = 8 * 1024 * 1024;
let approxBytes = 0;
let consecutiveFails = 0;
let lastErr: string | null = null;

try { approxBytes = fs.statSync(UI_TRACE_PATH).size; } catch { /* 尚不存在 */ }

function rotateIfOversized(): void {
  if (approxBytes < MAX_BYTES) return;
  try {
    fs.renameSync(UI_TRACE_PATH, UI_TRACE_PATH + '.old');
    approxBytes = 0;
  } catch {
    try { fs.writeFileSync(UI_TRACE_PATH, '', { encoding: 'utf8' }); approxBytes = 0; } catch { /* 下次再试 */ }
  }
}

function clip(v: unknown, max = 120): string {
  if (v == null) return '';
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  s = s.replace(/\s+/g, ' ');
  return s.length <= max ? s : s.slice(0, max) + `…[+${s.length - max}]`;
}

const UI_TRACE_ON = isDiagLogEnabled('tool-trace') || isCliDebugFlagPresent();

/* 模块加载即写一行 —— 跟 toolTraceLog 同一套路: 文件不存在就等于"这个模块压根没被
 * 打进当前进程", 这个信号本身就值一条。也让用户一启动就能看到文件在长。 */
if (UI_TRACE_ON) try {
  fs.appendFileSync(
    UI_TRACE_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ev: 'session_start', pid: process.pid, cwd: process.cwd() }) + '\n',
    { encoding: 'utf8' },
  );
} catch { /* 写不进去就算了, 绝不影响启动 */ }

export type UiTraceEvent =
  /** 时间线条目进出 —— 查"一次操作渲了几张卡" */
  | { ev: 'entry_add'; entryType: string; id?: number; key?: string; preview?: string; via?: string }
  | { ev: 'entry_commit'; entryType?: string; id?: number; key?: string; count?: number }
  | { ev: 'entry_drop'; entryType?: string; id?: number; key?: string; reason?: string }
  /** 运行态迁移 —— 查"结束了还在转" (who = 调用来源, 这是定位的关键) */
  | { ev: 'running'; value: boolean; who: string; status?: string }
  | { ev: 'status'; text: string; type?: string }
  /** 底部区块 —— 查遮挡/截断时的现场 */
  | { ev: 'bg_task'; action: string; id?: number; status?: string; count?: number }
  | { ev: 'layout'; rows?: number; cols?: number; note?: string }
  | { ev: 'note'; note: string; data?: unknown };

/** 常开写入。任何异常都吞掉 —— 取证日志绝不能反过来搞挂 UI。 */
export function uiTrace(event: UiTraceEvent): void {
  if (!UI_TRACE_ON) return;
  if (consecutiveFails >= 5) return;
  try {
    rotateIfOversized();
    const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...event }) + '\n';
    fs.appendFileSync(UI_TRACE_PATH, line, { encoding: 'utf8', mode: 0o600 });
    approxBytes += Buffer.byteLength(line, 'utf8');
    consecutiveFails = 0;
  } catch (err: any) {
    consecutiveFails++;
    const msg = err?.message || String(err);
    if (msg !== lastErr) {
      lastErr = msg;
      /* 不能用 console.* (会污染 TUI 画面, 见 feedback_infra_diagnostics_never_console) —
       * 写不进去就静默放弃, 连续 5 次后彻底停手。 */
    }
  }
}

export function getUiTracePath(): string {
  return UI_TRACE_PATH;
}

/**
 * 取调用来源 (跳过本文件和指定的自身方法), 返回最多 3 层函数名。
 * 用在低频的关键迁移上 (setRunning) —— "最后一次把 UI 点亮成 running 的是谁"这个问题,
 * 有调用栈就是一秒定位, 没有就只能靠猜。高频路径别用, Error 构造有成本。
 */
export function callerOf(selfName: string): string {
  const stack = new Error().stack || '';
  const frames: string[] = [];
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('uiTrace') || line.includes(selfName)) continue;
    const m = line.match(/at\s+(?:async\s+)?([\w$.<>]+)/);
    const name = m?.[1];
    if (!name || name === 'Object' || name === 'new') continue;
    frames.push(name);
    if (frames.length >= 3) break;
  }
  return frames.join(' ← ') || 'unknown';
}

export { clip as clipForUiTrace };
