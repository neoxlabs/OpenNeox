
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import type { ActionLogEvent } from '@neoxlabs/platform/platform/actionLog/types.js';

function sanitizeName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'workspace';
}

export function workspaceIdOf(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  return `${sanitizeName(path.basename(resolved))}-${hash}`;
}

export function eventsDirOf(workspacePath: string): string {
  return neoxHome('workspaces', workspaceIdOf(workspacePath), 'events');
}

export interface ReplayFilter {
  sessionId?: string;
  runId?: string;
  /** 只看这个时间之后的 (ms) */
  since?: number;
  /** 最多读多少条事件, 从**最新**往回数。默认 20000。 */
  maxEvents?: number;
}

/** 按时间顺序读出事件。文件按天分片, 文件名自带日期, 所以按名字排序就是时间序。 */
export function readEvents(workspacePath: string, filter: ReplayFilter = {}): ActionLogEvent[] {
  const dir = eventsDirOf(workspacePath);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const max = filter.maxEvents ?? 20_000;
  const out: ActionLogEvent[] = [];
  /* 从最新的文件往回读, 攒够就停 —— 一个长期用的工作区有几十万行, 全读进内存没必要 */
  for (let i = files.length - 1; i >= 0 && out.length < max; i--) {
    let text: string;
    try { text = fs.readFileSync(path.join(dir, files[i]!), 'utf8'); } catch { continue; }
    const batch: ActionLogEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e: ActionLogEvent;
      /* 一行坏了只丢这一行。审计最怕的是"因为一行 JSON 坏了就说这天什么都没发生" */
      try { e = JSON.parse(line) as ActionLogEvent; } catch { continue; }
      if (filter.sessionId && e.sessionId !== filter.sessionId) continue;
      if (filter.runId && e.runId !== filter.runId) continue;
      if (filter.since && e.ts < filter.since) continue;
      batch.push(e);
    }
    out.unshift(...batch);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out.length > max ? out.slice(out.length - max) : out;
}

export interface ReplayToolCall {
  name: string;
  ts: number;
  args?: unknown;
  ok?: boolean;
  ms?: number;
  error?: string;
  /** 收尾时那条一句话结果 (data.summary) */
  result?: string;
}

export interface ReplayRun {
  runId: string;
  startedAt: number;
  endedAt?: number;
  prompt?: string;
  model?: string;
  tools: ReplayToolCall[];
  files: string[];
  /** run_result 的结论; 没有 run_result = 这一轮**没跑完** (崩了 / 被杀 / 还在跑) */
  outcome?: 'ok' | 'error' | 'unfinished';
  error?: string;
}

export interface ReplaySession {
  sessionId: string;
  workspacePath: string;
  startedAt: number;
  endedAt: number;
  runs: ReplayRun[];
  /** 整个会话碰过的文件, 去重 */
  files: string[];
}

/** 事件序列 → 按轮次组织。跨轮次的顺序靠 seq, 不靠时间戳 (同毫秒的事件不少)。 */
export function buildReplay(events: ActionLogEvent[]): ReplaySession[] {
  const bySession = new Map<string, ActionLogEvent[]>();
  for (const e of events) {
    const key = e.sessionId ?? '(无会话)';
    (bySession.get(key) ?? bySession.set(key, []).get(key)!).push(e);
  }

  const sessions: ReplaySession[] = [];
  for (const [sessionId, evs] of bySession) {
    const runs = new Map<string, ReplayRun>();
    const files = new Set<string>();
    const byToolId = new Map<string, ReplayToolCall>();
    const open = new Map<string, ReplayToolCall[]>();

    for (const e of evs) {
      const runId = e.runId ?? '(无轮次)';
      let run = runs.get(runId);
      if (!run) {
        run = { runId, startedAt: e.ts, tools: [], files: [], outcome: 'unfinished' };
        runs.set(runId, run);
      }
      run.endedAt = e.ts;
      for (const f of e.files ?? []) { files.add(f); if (!run.files.includes(f)) run.files.push(f); }

      const d = (e.data ?? {}) as Record<string, any>;
      switch (e.type) {
        case 'run_start':
          run.startedAt = e.ts;
          run.prompt = typeof d.prompt === 'string' ? d.prompt : e.summary;
          break;
        case 'run_attempt':
          run.model = typeof d.model === 'string' ? d.model : (e.summary?.replace(/^Run:\s*/, '') || undefined);
          break;
        case 'file_change':
          if (typeof d.filePath === 'string') {
            files.add(d.filePath);
            if (!run.files.includes(d.filePath)) run.files.push(d.filePath);
          }
          break;
        case 'tool_call_start': {
          const call: ReplayToolCall = {
            name: String(d.name ?? d.tool ?? d.toolName ?? e.summary ?? '(未知工具)'),
            ts: e.ts,
            /* argsPreview 已经是字符串化并截过的 —— 落盘时就是这个形状, 别指望有原始对象 */
            args: d.argsPreview ?? d.args ?? d.arguments ?? d.input,
          };
          run.tools.push(call);
          if (typeof d.toolId === 'string') byToolId.set(d.toolId, call);
          else {
            const k = `${runId}::${call.name}`;
            (open.get(k) ?? open.set(k, []).get(k)!).push(call);
          }
          break;
        }
        case 'tool_call_end': {
          const name = String(d.name ?? d.tool ?? d.toolName ?? '');
          const call = (typeof d.toolId === 'string' ? byToolId.get(d.toolId) : undefined)
            ?? open.get(`${runId}::${name}`)?.pop();
          if (call) {
            call.ok = d.success !== false && !d.error;
            call.ms = typeof d.durationMs === 'number' ? d.durationMs : (e.ts - call.ts);
            if (d.error) call.error = String(d.error);
            if (typeof d.summary === 'string') call.result = d.summary;
            if (typeof d.toolId === 'string') byToolId.delete(d.toolId);
          } else {
            /* 只有收尾没有开头 —— 通常是读的窗口把开头切掉了。如实记一条,
             * 不要凭空补一个 start: 那会让"被截断"看起来像"完整" */
            run.tools.push({
              name: name || '(未知工具)', ts: e.ts,
              ok: d.success !== false && !d.error,
              error: d.error ? String(d.error) : undefined,
            });
          }
          break;
        }
        case 'run_result':
          run.outcome = d.failed ? 'error' : 'ok';
          if (d.failed && !run.error) run.error = String(d.outputPreview ?? e.summary ?? '失败');
          run.endedAt = e.ts;
          break;
        case 'run_error':
          run.outcome = 'error';
          run.error = e.reason || e.summary || String(d.error ?? '');
          run.endedAt = e.ts;
          break;
        default:
          break;
      }
    }

    const list = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
    sessions.push({
      sessionId,
      workspacePath: evs[0]?.workspacePath ?? '',
      startedAt: list[0]?.startedAt ?? 0,
      endedAt: list[list.length - 1]?.endedAt ?? 0,
      runs: list,
      files: [...files],
    });
  }
  return sessions.sort((a, b) => a.startedAt - b.startedAt);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function stamp(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 人读的回放。审计报告要能直接贴给别人看, 所以是 Markdown 不是 JSON dump。 */
export function renderReplayMarkdown(s: ReplaySession): string {
  const lines: string[] = [];
  lines.push(`# 会话回放 ${s.sessionId}`);
  lines.push('');
  lines.push(`- 工作区: ${s.workspacePath || '(未知)'}`);
  lines.push(`- 时间: ${stamp(s.startedAt)} → ${stamp(s.endedAt)}`);
  lines.push(`- 轮次: ${s.runs.length} · 碰过的文件: ${s.files.length}`);
  lines.push('');

  for (const [i, run] of s.runs.entries()) {
    const mark = run.outcome === 'ok' ? '✓' : run.outcome === 'error' ? '✗' : '…';
    lines.push(`## ${mark} 第 ${i + 1} 轮 · ${stamp(run.startedAt)}${run.model ? ` · ${run.model}` : ''}`);
    if (run.prompt) lines.push(`> ${clip(run.prompt, 300)}`);
    if (run.outcome === 'unfinished') {
      /* 这条必须显眼: "没有结论"跟"结论是成功"在审计上完全是两回事 */
      lines.push('');
      lines.push('**这一轮没有收尾记录** —— 崩了 / 被杀 / 或者当时还在跑。');
    }
    if (run.error) lines.push(`**失败**: ${clip(run.error, 300)}`);
    lines.push('');
    if (run.tools.length) {
      for (const t of run.tools) {
        const flag = t.ok === false ? '✗' : ' ';
        const ms = t.ms !== undefined ? ` ${t.ms}ms` : '';
        const arg = t.args ? ` ${clip(typeof t.args === 'string' ? t.args : JSON.stringify(t.args), 110)}` : '';
        const res = t.result ? ` → ${clip(t.result, 80)}` : '';
        lines.push(`- ${flag} \`${t.name}\`${ms}${arg}${res}${t.error ? ` — ${clip(t.error, 120)}` : ''}`);
      }
      lines.push('');
    }
    if (run.files.length) {
      lines.push(`改动的文件: ${run.files.map((f) => `\`${f}\``).join(', ')}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export interface SessionBrief {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  runs: number;
  files: number;
  firstPrompt?: string;
}

/** 列出这个工作区最近的会话 —— 审计的入口: 先看有哪些, 再挑一个回放。 */
export function listSessions(workspacePath: string, limit = 20): SessionBrief[] {
  const all = buildReplay(readEvents(workspacePath, { maxEvents: 20_000 }));
  return all
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, limit)
    .map((s) => ({
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      runs: s.runs.length,
      files: s.files.length,
      firstPrompt: s.runs[0]?.prompt ? clip(s.runs[0].prompt!, 80) : undefined,
    }));
}

/** 一步到位: 取一个会话的回放。找不到返回 null (**不是空回放** —— 那会看起来像"什么都没干")。 */
export function replaySession(workspacePath: string, sessionId: string): ReplaySession | null {
  const sessions = buildReplay(readEvents(workspacePath, { sessionId }));
  return sessions[0] ?? null;
}
