/**
 * toolTraceLog — 把每次工具调用的"完整链路"落盘成 JSONL,供事后定位 LLM
 * 为啥认为某次工具失败.
 *
 * 写两条记录:
 *   1. INVOKE — invokeTool 拿到 raw 结果时 (tool 实际返回什么 / success 是否被设)
 *   2. OUTCOME — orchestrate 出最终 outcome 时 (LLM 真正收到的字符串 / blockedBy)
 *
 * 路径: ~/.neox/logs/tool-trace.log
 *   (跟 cliLogger / neoxLogger / assistantLogger 同目录, 不再裸落 home 根)
 *
 *  重要 — 这个文件被 tsup 打包成 ESM, 不支持 `require()` 动态加载.
 *    必须用 ES static import(`import * as fs from 'node:fs'`),否则运行时炸:
 *      "Dynamic require of \"fs\" is not supported"
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDiagLogEnabled } from '../../platform/diagLogGate.js';
import { NEOX_HOME_DIRNAME } from '../../platform/neoxHome.js';

/* 发布审计 P0: 这个 trace 里有**工具参数、绝对路径、输出预览**,
 * 而它从来是无条件写的 —— 用户没打开过任何调试开关, 磁盘上就已经躺着一份
 * "他这台机器上都干了什么"。同类的 ui-trace / mobile-bridge / workspace-watcher
 * 早就接了 diagLogGate, 唯独这条漏了。现在接上, 默认不写。
 *   开: NEOX_DIAG_LOG=1 或 NEOX_DIAG_LOG=tool-trace。
 * 注意判定要**每次调用时算**而不是模块加载时算一次: 进程里可以运行期改 env
 * (桌面端「关于页连点版本号」那个开关就是运行期设的), 缓存住等于开关失灵。 */
const TRACE_CHANNEL = 'tool-trace';
function traceEnabled(): boolean {
  return isDiagLogEnabled(TRACE_CHANNEL);
}

function resolveLogPath(): string {
  try {
    const dir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'logs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 目录已存在 */ }
    return path.join(dir, 'tool-trace.log');
  } catch {
    return '/tmp/neox-tool-trace.log';
  }
}

const TRACE_LOG_PATH = resolveLogPath();
let consecutiveFailCount = 0;
let lastErrMsg: string | null = null;

/* trace 通过诊断日志开关控制，并在达到大小上限时轮转为 .old，最多保留最近两代。
 * 大小使用进程内累计值和启动时的 statSync，避免每次 append 都访问文件系统。 */
const TRACE_LOG_MAX_BYTES = 16 * 1024 * 1024;
let approxLogBytes = 0;
try {
  approxLogBytes = fs.statSync(TRACE_LOG_PATH).size;
} catch { /* 文件尚不存在 */ }

/* 0600 而不是默认的 0644: 这里面是这台机器上跑过的工具参数和路径,
 * 同机的其他账号没有理由读得到 (neoxLogger / auditLog 早就是 0600 了)。
 * mode 只在**创建**时生效, 所以旧机器上已存在的 0644 文件要额外 chmod 一次。 */
const LOG_FILE_MODE = 0o600;
let permsHardened = false;
function hardenLogPerms(): void {
  if (permsHardened) return;
  permsHardened = true;
  for (const p of [TRACE_LOG_PATH, TRACE_LOG_PATH + '.old']) {
    try { fs.chmodSync(p, LOG_FILE_MODE); } catch { /* 不存在或非本人所有 — 无所谓 */ }
  }
}

function rotateIfOversized(): void {
  if (approxLogBytes < TRACE_LOG_MAX_BYTES) return;
  try {
    fs.renameSync(TRACE_LOG_PATH, TRACE_LOG_PATH + '.old');
    approxLogBytes = 0;
  } catch {
    /* rename 失败 (权限/竞争) — 直接截断重来, 宁可丢历史也不吃磁盘 */
    try {
      fs.writeFileSync(TRACE_LOG_PATH, '', { encoding: 'utf8' });
      approxLogBytes = 0;
    } catch { /* 都失败则放弃本次轮转, 下次 append 再试 */ }
  }
}

/* 模块加载时写一行 — 这样用户重启 Electron 后立刻能看到 log 文件,
   如果文件不存在 = 这个 module 根本没被 import 进当前进程。
    必须在闸门之后: 否则"默认不写"名存实亡 —— 只要有人 import 了这个模块,
   文件就已经被创建出来了。 */
if (traceEnabled()) {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(
      TRACE_LOG_PATH,
      JSON.stringify({ ts, phase: 'module_loaded', pid: process.pid, path: TRACE_LOG_PATH }) + '\n',
      { encoding: 'utf8', mode: LOG_FILE_MODE },
    );
    hardenLogPerms();
  } catch (err: any) {
    console.error(`[toolTraceLog] startup write failed (path=${TRACE_LOG_PATH}): ${err?.message || err}`);
  }
}

function clip(s: unknown, max: number): string {
  if (s == null) return '';
  let str: string;
  try {
    str = typeof s === 'string' ? s : JSON.stringify(s);
  } catch {
    str = String(s);
  }
  if (str.length <= max) return str;
  return str.slice(0, max) + `…[${str.length - max} more chars]`;
}

export interface ToolTraceInvokeRecord {
  phase: 'invoke';
  toolName: string;
  toolCallId?: string;
  argsPreview: string;          // clip 800
  rawOutputPreview: string;     // clip 1500 — 工具原始返回 (可能是 ToolResult JSON)
  success: boolean;
  durationMs?: number;
  errorName?: string;           // 工具内部 throw 的话
  errorMsg?: string;
  hasUiMeta: boolean;
  uiMetaStatus?: string;
}

export interface ToolTraceOutcomeRecord {
  phase: 'outcome';
  toolName: string;
  toolCallId?: string;
  success: boolean;
  blockedBy?: string;           // gate 拦的话, 例如 'permission' / 'loop' / 'risk'
  finalOutputPreview: string;   // clip 2000 — 真正写进 LLM tool_result 的字符串
  hasEscalationHint: boolean;   // result 末尾是否被拼了 errorPatternMemory 的 hint
  totalDurationMs?: number;
  stageTimings?: Record<string, number>;
  toolKind?: string;
  toolStatus?: string;
}

/** LLM 流结束后, runner 收到的 tool_call 总览 (在 mode filter / orchestrate 之前) */
export interface ToolTraceBatchReceivedRecord {
  phase: 'batch_received';
  callCount: number;
  callIds: string[];
  callNames: string[];
  /** 完整 raw tool_calls — 不截断, 包含 args 原文. 用来对照"LLM 实际发了什么" */
  rawToolCalls: Array<{
    id: string;
    type?: string;
    name: string;
    arguments: string;
  }>;
  /** LLM 这一轮的 raw text (clip 800), 看是否模型在 text 里也提到了那些"消失"的工具 */
  assistantTextPreview?: string;
  iteration?: number;
  modelName?: string;
}

/** mode filter 或工具集过滤拦截的 tool_call。它们不进入 invoke，直接以 denialOutput 写入 memory。 */
export interface ToolTraceFilteredRecord {
  phase: 'filtered';
  toolCallId?: string;
  toolName: string;
  reason: string;       // mode_blocked / unknown_tool 等
  denialOutput?: string;
}

/** 在请求发送前记录 messages 中 tool_call/tool_result 的配对情况。Anthropic 协议要求一一对应。 */
export interface ToolTraceLLMRequestRecord {
  phase: 'llm_request';
  iteration?: number;
  modelName?: string;
  /** 发起请求的 agent 名，用于按 agent 维度聚合统计并区分主 agent 与子 agent。 */
  agentName?: string;
  totalMessages: number;
  /** assistant 消息里出现的所有 tool_call_id (按出现顺序) */
  toolCallIds: string[];
  /** tool 消息里出现的所有 tool_call_id (应该跟上面一一对应) */
  toolResultIds: string[];
  /** 配对差异: assistant 提了但 tool 缺响应的 id (这就是丢失的) */
  missingToolResultIds: string[];
  /** 反过来: tool 响应了但 assistant 没提到的 id (基本不该出现) */
  orphanToolResultIds: string[];
  /** 各 role 的消息数, 看消息分布 */
  roleCounts: Record<string, number>;
  /** 最后 3 条 assistant 消息里的 tool_calls.arguments 摘要 — 看 LLM 历史里
   *  args 是不是被 EMPTY_INPUT 占位污染了. 每条 clip 200 字. */
  recentToolCallArgs?: Array<{ name: string; argsPreview: string; pollutedByEmptyInput: boolean }>;
  /** 最后一组 (assistant tool_calls + 后续 tool 响应) 的实际内容 dump.
   *  这是判断"工具是否真的传进 LLM"的最直接证据 — 不再靠"可能". */
  lastTurnDump?: {
    /** 最后一个带 tool_calls 的 assistant message: 每个 tool_call 的 id+name+args clip 300 */
    lastAssistantToolCalls: Array<{ id: string; name: string; argsPreview: string }>;
    /** 紧跟其后的 tool 消息们: 按时间序, 每个 tool_call_id+name+content clip 400 */
    followingToolResults: Array<{
      toolCallId: string;
      name: string;
      contentPreview: string;
      contentLength: number;
      isErrorLooking: boolean;  // content 含 error/失败/EMPTY_INPUT 等关键词
    }>;
  };
}

export type ToolTraceRecord =
  | ToolTraceInvokeRecord
  | ToolTraceOutcomeRecord
  | ToolTraceBatchReceivedRecord
  | ToolTraceFilteredRecord
  | ToolTraceLLMRequestRecord;

export function appendToolTrace(record: ToolTraceRecord): void {
  if (!traceEnabled()) return;
  if (consecutiveFailCount >= 5) return;
  try {
    rotateIfOversized();
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, ...record }) + '\n';
    fs.appendFileSync(TRACE_LOG_PATH, line, { encoding: 'utf8', mode: LOG_FILE_MODE });
    hardenLogPerms();
    approxLogBytes += Buffer.byteLength(line, 'utf8');
    consecutiveFailCount = 0;
  } catch (err: any) {
    consecutiveFailCount++;
    const msg = err?.message || String(err);
    if (msg !== lastErrMsg) {
      lastErrMsg = msg;
      console.error(`[toolTraceLog] write failed (path=${TRACE_LOG_PATH}): ${msg}`);
    }
  }
}

export function getToolTraceLogPath(): string {
  return TRACE_LOG_PATH;
}

export { clip as clipForToolTrace };
