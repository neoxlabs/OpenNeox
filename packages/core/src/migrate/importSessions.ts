
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import type { SavedTimelineEntry } from '@neoxlabs/platform/shared/ipc.js';
import { getDatabase } from '@neoxlabs/platform/platform/database.js';
import { SQLiteSession } from '../memory/sqlite-session.js';
import { sessionStore } from '../platform/sessionStore.js';

/** 单行上限 —— 超过必是内联附件, 不是对话内容 */
const MAX_LINE_BYTES = 2 * 1024 * 1024;
/** 单个会话最多搬多少条 —— 防一个 40MB 的会话把导入卡住 */
const MAX_ITEMS = 4000;
/** 单条文本上限 —— 工具输出动辄几十万字, 界面渲染不动, 模型也用不上 */
const MAX_TEXT = 20000;

export type MigrationSource = 'claude-code' | 'codex';

export interface ImportedSessionDraft {
  sessionId: string;
  name: string;
  workspacePath: string;
  modelId: string;
  createdAt: number;
  updatedAt: number;
  items: Array<Record<string, unknown>>;
  timeline: SavedTimelineEntry[];
  /** 因为太长/是附件而被丢掉的行数 —— 报给用户, 别假装完整搬过来了 */
  skipped: number;
}

const HARNESS_BLOCK = /^<(recommended_plugins|environment_context|user_instructions|system-reminder|command-name|command-message|command-args|local-command-stdout|ide_[a-z_]+)>/i;

export function isHarnessBlock(text: string): boolean {
  return HARNESS_BLOCK.test(text.trim());
}

export function stripHarnessNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .trim();
}

function clip(s: unknown): string {
  const t = typeof s === 'string' ? s : (s == null ? '' : JSON.stringify(s));
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n…（已截断 ${t.length - MAX_TEXT} 字）` : t;
}

/** Anthropic / OpenAI 的 content 数组 → 纯文本 (图片转占位, 密文丢弃) */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const blk = b as Record<string, unknown>;
    switch (blk.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        if (typeof blk.text === 'string') parts.push(blk.text);
        break;
      case 'image':
      case 'input_image':
        /* base64 不搬 —— 见文件头第 2 条 */
        parts.push('[图片]');
        break;
      case 'thinking':
        /* thinking 正文可以留 (是人能读的), signature 丢 */
        if (typeof blk.thinking === 'string') parts.push(blk.thinking);
        break;
      default:
        break;
    }
  }
  return parts.join('\n').trim();
}

interface Sink {
  items: Array<Record<string, unknown>>;
  timeline: SavedTimelineEntry[];
  seq: number;
}

function pushMessage(sink: Sink, role: 'user' | 'assistant' | 'system', text: string, ts: number): void {
  if (!text) return;
  sink.items.push({ type: 'message', data: { role, content: clip(text) } });
  sink.timeline.push({
    id: `mig-${sink.seq}`,
    type: role === 'user' ? 'user_message' : 'assistant_message',
    title: role === 'user' ? 'User' : 'Assistant',
    detail: clip(text),
    timestamp: ts,
    sequence: sink.seq,
  });
  sink.seq++;
}

function pushToolCall(sink: Sink, callId: string, name: string, args: unknown, ts: number): void {
  sink.items.push({ type: 'tool_call', data: { id: callId, name, arguments: args } });
  sink.timeline.push({
    id: `mig-${sink.seq}`,
    type: 'tool_call',
    title: name,
    toolName: name,
    detail: clip(args),
    timestamp: ts,
    sequence: sink.seq,
  });
  sink.seq++;
}

function pushToolResult(sink: Sink, callId: string, name: string, result: unknown, ok: boolean, ts: number): void {
  sink.items.push({ type: 'tool_result', data: { callId, name, result: clip(result), success: ok } });
  sink.timeline.push({
    id: `mig-${sink.seq}`,
    type: ok ? 'tool_result' : 'tool_error',
    title: name,
    toolName: name,
    success: ok,
    detail: clip(result),
    timestamp: ts,
    sequence: sink.seq,
  });
  sink.seq++;
}

/** 按行流式读; 超长行直接丢 (计数报给调用方) */
async function eachLine(
  file: string,
  onLine: (obj: Record<string, unknown>) => void,
): Promise<number> {
  let skipped = 0;
  const stream = fs.createReadStream(file, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      if (line.length > MAX_LINE_BYTES) { skipped++; continue; }
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { skipped++; continue; }
      if (obj && typeof obj === 'object') onLine(obj as Record<string, unknown>);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return skipped;
}

/* ── Claude Code ────────────────────────────────────────────────────────── */

/**
 * `~/.claude/projects/<slug>/<uuid>.jsonl`
 *
 *   有用的只有 type:'user' / 'assistant' 两种行 (外加 ai-title 拿标题)。
 *   工具结果回来时也是 type:'user', 但 content 里是 tool_result 块 —— 不能当用户发言。
 *   isSidechain:true 是子 agent 分支, 这一版**不搬** (它在 Neox 是独立 session + parentSessionId,
 *   搬进主会话会把两条时间线搅在一起)。
 */
async function parseClaudeCode(file: string): Promise<ImportedSessionDraft> {
  const sink: Sink = { items: [], timeline: [], seq: 0 };
  let title = '';
  let firstUserText = '';
  let cwd = '';
  let model = '';
  let firstTs = 0;
  let lastTs = 0;

  const skipped = await eachLine(file, (row) => {
    if (sink.items.length >= MAX_ITEMS) return;

    if (row.type === 'ai-title' && typeof row.title === 'string') { title = row.title; return; }
    if (row.type !== 'user' && row.type !== 'assistant') return;
    if (row.isSidechain === true) return;

    if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;
    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    const t = Number.isFinite(ts) ? ts : Date.now();
    if (!firstTs) firstTs = t;
    lastTs = t;

    const msg = row.message as Record<string, unknown> | undefined;
    if (!msg) return;
    if (!model && typeof msg.model === 'string') model = msg.model;

    const content = msg.content;

    if (row.type === 'user') {
      /* 工具结果伪装成 user 行 —— 按 tool_result 收, 不是用户发言 */
      const blocks = Array.isArray(content) ? content : [];
      const toolResults = blocks.filter((b: any) => b?.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults as any[]) {
          pushToolResult(sink, String(tr.tool_use_id ?? ''), 'tool', contentToText(tr.content) || tr.content, tr.is_error !== true, t);
        }
        return;
      }
      const text = stripHarnessNoise(contentToText(content));
      if (text && !isHarnessBlock(text)) {
        if (!firstUserText) firstUserText = text;
        pushMessage(sink, 'user', text, t);
      }
      return;
    }

    /* assistant: 文本 + thinking 合成一条, tool_use 各自一条 */
    const text = contentToText(content);
    if (text) pushMessage(sink, 'assistant', text, t);
    if (Array.isArray(content)) {
      for (const b of content as any[]) {
        if (b?.type === 'tool_use') {
          pushToolCall(sink, String(b.id ?? ''), String(b.name ?? 'tool'), b.input, t);
        }
      }
    }
  });

  const stat = fs.statSync(file);
  return {
    sessionId: path.basename(file, '.jsonl'),
    name: title || firstUserText.slice(0, 40) || 'Claude Code 会话',
    workspacePath: cwd,
    modelId: model,
    createdAt: firstTs || stat.birthtimeMs || stat.mtimeMs,
    updatedAt: lastTs || stat.mtimeMs,
    items: sink.items,
    timeline: sink.timeline,
    skipped,
  };
}

/* ── Codex ──────────────────────────────────────────────────────────────── */

/**
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 *
 *   只认 `type:'response_item'` (权威 transcript) + 第一行的 `session_meta`。
 *   `event_msg` 是同一句话的 UI 副本 —— 收了就重复; `turn_context` 是运行参数不是对话。
 *   role:'developer' 是 Codex 自己注入的系统提示, 不搬 (那是它的 harness 不是用户的对话)。
 */
async function parseCodex(file: string): Promise<ImportedSessionDraft> {
  const sink: Sink = { items: [], timeline: [], seq: 0 };
  let sessionId = '';
  let cwd = '';
  let model = '';
  let firstTs = 0;
  let lastTs = 0;
  let firstUserText = '';
  /* call_id → 工具名, 让 function_call_output 能显示成"哪个工具的结果" */
  const callNames = new Map<string, string>();

  const skipped = await eachLine(file, (row) => {
    if (sink.items.length >= MAX_ITEMS) return;

    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    const t = Number.isFinite(ts) ? ts : Date.now();
    const payload = row.payload as Record<string, unknown> | undefined;

    if (row.type === 'session_meta' && payload) {
      if (typeof payload.id === 'string') sessionId = payload.id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      if (!firstTs) firstTs = t;
      return;
    }
    if (row.type === 'turn_context' && payload) {
      if (!model && typeof payload.model === 'string') model = payload.model;
      return;
    }
    if (row.type !== 'response_item' || !payload) return;

    if (!firstTs) firstTs = t;
    lastTs = t;

    switch (payload.type) {
      case 'message': {
        const role = payload.role;
        if (role !== 'user' && role !== 'assistant') return;   /* developer/system 不搬 */
        const text = stripHarnessNoise(contentToText(payload.content));
        if (!text) return;
        if (role === 'user' && isHarnessBlock(text)) return;   /* harness 注入不是对话 */
        if (role === 'user' && !firstUserText) firstUserText = text;
        pushMessage(sink, role, text, t);
        return;
      }
      case 'function_call': {
        const callId = String(payload.call_id ?? '');
        const name = String(payload.name ?? 'tool');
        callNames.set(callId, name);
        pushToolCall(sink, callId, name, payload.arguments, t);
        return;
      }
      case 'function_call_output': {
        const callId = String(payload.call_id ?? '');
        pushToolResult(sink, callId, callNames.get(callId) ?? 'tool', payload.output, true, t);
        return;
      }
      /* reasoning: encrypted_content 是密文, summary 常年为空 —— 整条跳过 */
      default:
        return;
    }
  });

  const stat = fs.statSync(file);
  const fallbackId = /([0-9a-f-]{36})\.jsonl$/i.exec(path.basename(file))?.[1] ?? path.basename(file, '.jsonl');
  return {
    sessionId: sessionId || fallbackId,
    name: firstUserText.slice(0, 40) || 'Codex 会话',
    workspacePath: cwd,
    modelId: model,
    createdAt: firstTs || stat.birthtimeMs || stat.mtimeMs,
    updatedAt: lastTs || stat.mtimeMs,
    items: sink.items,
    timeline: sink.timeline,
    skipped,
  };
}

/** 只解析不落盘 —— 给 CLI 的 dry-run 和测试用 */
export async function parseExternalSession(file: string, source: MigrationSource): Promise<ImportedSessionDraft> {
  return source === 'codex' ? parseCodex(file) : parseClaudeCode(file);
}

export interface ImportSessionResult {
  sessionId: string;
  name: string;
  messages: number;
  skipped: number;
  /** 已经导过 (库里有同 id) —— 不重复导, 也不算失败 */
  duplicate?: boolean;
}

/**
 * 解析 + 落盘一个会话。
 *
 *   会话 id 直接沿用源里的 uuid —— 于是"再导一次"天然是幂等的 (库里查得到就跳过),
 *   不用另外维护一张"导过哪些"的表。
 *
 *   workspacePath 读不到时留空串: 侧栏会把它归到「未关联」那一组, 照样能点开看。
 *   **不从目录名猜路径** —— discoverSessions.ts 头部记着那个反例。
 */
export async function importExternalSession(
  file: string,
  source: MigrationSource,
): Promise<ImportSessionResult> {
  const draft = await parseExternalSession(file, source);
  const db = getDatabase();

  if (db.getSession(draft.sessionId)) {
    return { sessionId: draft.sessionId, name: draft.name, messages: 0, skipped: draft.skipped, duplicate: true };
  }

  await sessionStore.createSession({
    sessionId: draft.sessionId,
    workspacePath: draft.workspacePath,
    modelId: draft.modelId,
    name: draft.name,
  });

  if (draft.items.length > 0) {
    const sqliteSession = new SQLiteSession(draft.sessionId);
    await sqliteSession.addItems(draft.items as any);
  }
  if (draft.timeline.length > 0) {
    db.setTimeline(draft.sessionId, draft.timeline);
  }

  /* createSession 把 created_at/updated_at 写成了"现在" —— 补回真实时间,
   * 否则侧栏按 updated_at 排序会把三个月前的老会话全顶到最上面。 */
  db.upsertSession({
    id: draft.sessionId,
    name: draft.name,
    modelId: draft.modelId || '',
    workspacePath: draft.workspacePath,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    totalTokens: 0,
    contextUsed: 0,
    fileRollbackCheckpointId: null,
    fileReapplyCheckpointId: null,
    fileRevertedMap: {},
    fileConfirmedMap: {},
    parentSessionId: null,
    kind: 'chat',
  } as any);

  return { sessionId: draft.sessionId, name: draft.name, messages: draft.items.length, skipped: draft.skipped };
}
