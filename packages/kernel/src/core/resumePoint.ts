/**
 * ResumePoint — 工具级断点落盘 (work E-01).
 *
 * 已有的 interrupted_runs 表只记到 turn 粒度 ("这个会话有一轮在跑"), 进程被 kill 之后
 * 没人知道这一轮停在第几次工具调用、哪些文件已经写完了。这里补上工具粒度:
 *
 * 每次工具结果出来就往 `<NEOX_HOME>/resume/<sessionId>.jsonl` 追加一行快照,
 * 内容是 `{stepId, completedFiles[], pendingGate?}` 的累计值。重启后读最后一行即可知道
 * 断在哪一步、哪些文件已经落地。
 *
 * 为什么是 JSONL 追加而不是每次重写整个 JSON:
 *   - 进程随时可能被 kill, 追加只动文件尾部, 不会写坏前面已经落盘的快照;
 *   - 一行写一半只会弄坏最后一行, 读取时跳过坏行往前找即可 (见 readResumePoint)。
 *
 * 这个模块只负责"落盘 + 读回", 不做恢复 / 续跑 (那是 E-02)。写盘失败一律吞掉:
 * 断点是辅助信息, 不能因为它让 agent 循环挂掉。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { neoxHome } from '../platform/neoxHome.js';

/** 停下来等用户确认的闸 (例如交付闸 / 审批) */
export interface ResumePendingGate {
  toolName: string;
  reason: string;
}

export interface ResumePoint {
  version: 1;
  sessionId: string;
  /** 停在哪一步: `${iteration}.${本批次内第几个工具}` (1 起), 形如 "3.2" */
  stepId: string;
  /** agent 循环轮次 (1 起) */
  iteration: number;
  /** 最后一次落盘对应的工具名 */
  toolName: string;
  toolCallId: string;
  /** 本 run 内已经被成功写过的文件 (绝对路径, 去重 + 排序) */
  completedFiles: string[];
  /** 最后一次工具调用停在闸上时才有 */
  pendingGate?: ResumePendingGate;
  updatedAt: number;
}

export interface ResumePointToolResult {
  iteration: number;
  /** 本批次内第几个工具 (0 起) */
  index: number;
  toolName: string;
  toolCallId: string;
  /** 原始入参 JSON 字符串 (模型给的, 可能不合法) */
  argsRaw?: string;
  output: string;
  success: boolean;
}

export interface ResumePointRecorder {
  readonly filePath: string;
  /** 每次工具结果落一次盘; 失败返回 null, 绝不抛 */
  recordToolResult(input: ResumePointToolResult): ResumePoint | null;
  /** 读回最近一次快照 (内存优先, 否则读盘) */
  read(): ResumePoint | null;
}

export interface ResumePointToolCallLike {
  id: string;
  function?: { name?: string; arguments?: string };
}

export interface ResumePointToolResultLike {
  id: string;
  name: string;
  output?: string;
  success: boolean;
}

/**
 * runner 收口点用的一步调用: 把一批工具结果按顺序落成断点。
 * 断点只是辅助信息 —— 这里绝不抛, 也不影响 agent 循环。
 */
export function recordToolResultsForResume(
  recorder: ResumePointRecorder | undefined,
  results: readonly ResumePointToolResultLike[],
  toolCalls: readonly ResumePointToolCallLike[],
  iteration: number,
): void {
  if (!recorder) return;
  results.forEach((result, index) => {
    recorder.recordToolResult({
      iteration,
      index,
      toolName: result.name,
      toolCallId: result.id,
      argsRaw: toolCalls.find((call) => call.id === result.id)?.function?.arguments,
      output: typeof result.output === 'string' ? result.output : '',
      success: result.success,
    });
  });
}

export interface CreateResumePointRecorderOptions {
  sessionId: string;
  /** 覆盖落盘目录 (测试用); 默认 `neoxHome('resume')` */
  dir?: string;
  /** 相对路径按这个工作区解析 (工具入参里的 file_path 常常是相对路径) */
  workspacePath?: string;
  /** 文件超过这个大小就只保留最后一帧, 默认 2MB */
  maxBytes?: number;
  now?: () => number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 默认落盘目录 —— 跟 tool-trace.log 一样放在 NEOX_HOME 下, 不写工作区 */
export function resumePointDir(): string {
  return neoxHome('resume');
}

/** sessionId 直接拼文件名前必须洗掉路径分隔符, 否则 `../x` 能写到别处 */
export function resumePointFileName(sessionId: string): string {
  const safe = String(sessionId || 'unknown')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120);
  return `${safe || 'unknown'}.jsonl`;
}

/** 读回某个会话最后一次落盘的断点; 没有 / 全坏 → null */
export function readResumePoint(sessionId: string, dir?: string): ResumePoint | null {
  const filePath = path.join(dir ?? resumePointDir(), resumePointFileName(sessionId));
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as ResumePoint;
      if (parsed && parsed.version === 1 && parsed.sessionId === sessionId) return parsed;
    } catch {
      /* 被 kill 时写了一半的最后一行 —— 往前找上一条完整快照 */
    }
  }
  return null;
}

export function createResumePointRecorder(options: CreateResumePointRecorderOptions): ResumePointRecorder {
  const dir = options.dir ?? resumePointDir();
  const filePath = path.join(dir, resumePointFileName(options.sessionId));
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let state: ResumePoint | null | undefined;   // undefined = 还没读过盘

  const current = (): ResumePoint | null => {
    if (state === undefined) state = readResumePoint(options.sessionId, dir);
    return state;
  };

  return {
    filePath,
    read: current,
    recordToolResult(input) {
      try {
        const prev = current();
        const completed = new Set(prev?.completedFiles ?? []);
        for (const file of extractCompletedFiles(input.argsRaw, input.success, options.workspacePath)) {
          completed.add(file);
        }
        const point: ResumePoint = {
          version: 1,
          sessionId: options.sessionId,
          stepId: `${input.iteration}.${input.index + 1}`,
          iteration: input.iteration,
          toolName: input.toolName,
          toolCallId: input.toolCallId,
          completedFiles: [...completed].sort(),
          pendingGate: extractPendingGate(input.output),
          updatedAt: now(),
        };
        appendSnapshot(filePath, point, maxBytes);
        state = point;
        return point;
      } catch {
        return null;
      }
    },
  };
}

function appendSnapshot(filePath: string, point: ResumePoint, maxBytes: number): void {
  const line = `${JSON.stringify(point)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { /* 还没建 */ }
  if (size > maxBytes) {
    /* 文件长太大了: 只留当前这一帧。读回只认最后一行, 丢历史没有损失。 */
    fs.writeFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
    return;
  }
  fs.appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
}

/** 入参里这些字段按"文件路径"理解 (写类工具的实际落盘参数各有叫法) */
const FILE_PATH_KEYS = [
  'file_path', 'filePath', 'path', 'save_path', 'savePath', 'save_as',
  'output_path', 'outputPath', 'out_path', 'outPath', 'target', 'destination', 'dest',
];

function extractCompletedFiles(
  argsRaw: string | undefined,
  success: boolean,
  workspacePath?: string,
): string[] {
  if (!success || !argsRaw) return [];
  let args: unknown;
  try { args = JSON.parse(argsRaw); } catch { return []; }
  const candidates = new Set<string>();
  collectPathValues(args, candidates, 0);
  const out: string[] = [];
  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(workspacePath ?? process.cwd(), candidate);
    try {
      if (fs.statSync(abs).isFile()) out.push(abs);
    } catch { /* 不存在 = 没写成 */ }
  }
  return out;
}

/** 最多往下钻 3 层: 覆盖 `call_tool({name, args:{file_path}})` 这层包装 */
function collectPathValues(value: unknown, out: Set<string>, depth: number): void {
  if (!value || typeof value !== 'object' || depth > 3) return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && FILE_PATH_KEYS.includes(key) && v.trim()) {
      out.add(v.trim());
    } else if (v && typeof v === 'object') {
      collectPathValues(v, out, depth + 1);
    }
  }
}

/** 工具结果里出现这些键 = 停在了闸上 (交付闸 / 审批) */
const GATE_KEYS = [
  'pendingGate', 'pending_gate', 'requiresApproval', 'requires_approval',
  'needsUserConfirmation', 'needs_user_confirmation', 'awaitingApproval', 'awaiting_approval',
];

/** 结果 JSON 里点名停在闸上时, 抽成 pendingGate */
export function extractPendingGate(output: string): ResumePendingGate | undefined {
  if (!output || typeof output !== 'string') return undefined;
  const first = output.trimStart()[0];
  if (first !== '{' && first !== '[') return undefined;
  let parsed: any;
  try { parsed = JSON.parse(output); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const gateKey = GATE_KEYS.find((k) => parsed[k]);
  const blockedByGate = parsed.error === 'delivery_gate_blocked' || parsed.error === 'gate_blocked';
  if (!gateKey && !blockedByGate) return undefined;

  const raw = gateKey ? parsed[gateKey] : undefined;
  const reason = typeof raw === 'string'
    ? raw
    : raw?.reason || raw?.hint || parsed.hint || parsed.message || parsed.error || '等待确认';
  return {
    toolName: typeof parsed.tool === 'string' ? parsed.tool : '',
    reason: String(reason).slice(0, 500),
  };
}
