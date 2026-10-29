import type { TimelineEntry } from '../../../utils/workspaceUtils';
import type { StepContent } from '../types';
import { unwrapContextualOutput } from '../unwrapToolOutput';
import { stripToolHintHeader } from '../toolResultHint';
import { cronToHuman } from '../cronHuman';
import { getGlobalLanguage } from '../../../hooks/useI18n';
import type { KV, ToolCard } from './toolCardTypes';
import { EXTRA_PARSERS } from './extraParsers';

const isZhUi = () => getGlobalLanguage() === 'zh';

type Args = Record<string, unknown>;
type Parser = (args: Args, out: string, entry: TimelineEntry) => ToolCard | undefined;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function json(out: string): any {
  const t = stripToolHintHeader((out || '').trim());
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}
/** contextual / ephemeral 信封里的正文, 没信封就原样 */
function body(out: string): string {
  const env = unwrapContextualOutput(out);
  return env?.content ?? stripToolHintHeader((out || '').trim());
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function fmtDuration(sec?: number): string | undefined {
  if (sec === undefined) return undefined;
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ── 演示稿: deck_begin (大纲) / create_slides (逐页 slots) ── T/pptx/deckTools.ts:278, createSlidesTool.ts:48 */
const slides: Parser = (a, out, e) => {
  const t = (e.toolName || '').toLowerCase();
  const r = json(out);
  if (t === 'deck_begin' && Array.isArray(a.outline)) {
    const list = (a.outline as Args[]).map((s) => ({ title: str(s?.title) ?? '', layout: str(s?.template) })).filter((s) => s.title);
    return list.length ? { kind: 'slides', total: list.length, slides: list } : undefined;
  }
  if (t === 'create_slides' && Array.isArray(a.slides) && r?.success) {
    const list = (a.slides as Args[]).map((s, i) => {
      const slots = (s?.slots && typeof s.slots === 'object' ? s.slots : {}) as Args;
      const title = str(slots.title) ?? str(slots.heading) ?? str(slots.headline) ?? `第 ${i + 1} 页`;
      return { title, layout: str(s?.template) };
    });
    return { kind: 'slides', file: str(r.path), total: num(r.slideCount) ?? list.length, slides: list };
  }
  if (t === 'deck_export' && r?.ok && str(r.path)) {
    return { kind: 'slides', file: str(r.path), total: num(r.slideCount), slides: [] };
  }
  return undefined;
};

/* ── 读文档: pptx_read 文本头 / sheet_describe / word_describe ── */
const readDoc: Parser = (a, out, e) => {
  const t = (e.toolName || '').toLowerCase();
  if (t === 'pptx_read') {
    /* `file=<abs> · 5 slides · showing 1,3` */
    const m = /^file=(.+?) · (\d+) slides(?: · showing ([\d,\-\s]+))?/m.exec(body(out));
    return m ? { kind: 'read_doc', file: m[1]!, totalPages: Number(m[2]), pages: m[3]?.trim() } : undefined;
  }
  if (t === 'sheet_describe') {
    const r = json(out);
    const s0 = Array.isArray(r?.sheets) ? r.sheets[0] : undefined;
    const file = str(a.file_path) ?? str(a.path);
    return s0 && file ? { kind: 'read_doc', file, sheet: str(s0.name), rows: num(s0.rows), cols: num(s0.cols) } : undefined;
  }
  if (t === 'word_describe') {
    const r = json(out);
    const file = str(a.file_path) ?? str(a.path);
    return r && file && num(r.characters) !== undefined ? { kind: 'read_doc', file, chars: num(r.characters) } : undefined;
  }
  return undefined;
};

/* ── 分享网页 ── T/share/sharePageTool.ts:21 {ok,url,files,bytes} */
const share: Parser = (a, out) => {
  const r = json(out);
  if (!r?.ok || !str(r.url)) return undefined;
  return { kind: 'link', url: r.url, title: str(a.title) };
};

/* ── 做视频 ── T/video/renderVideoTool.ts:151 {status,output,duration,width,height} */
const video: Parser = (a, out) => {
  const r = json(out);
  if (r?.status !== 'success' || !str(r.output)) return undefined;
  const res = num(r.height) ? `${r.height}p` : undefined;
  return { kind: 'video', path: r.output, duration: fmtDuration(num(r.duration)), resolution: res, title: str(a.title) };
};

/* ── 改图: 原图 → 结果 ── T/imagegen/imageGenTools.ts:364 {success,paths} */
const editImage: Parser = (a, out) => {
  const r = json(out);
  const before = str(a.image_path) ?? str(a.input_path) ?? str(a.source) ?? str(a.image)
    ?? (Array.isArray(a.images) ? str(a.images[0]) : undefined) ?? (Array.isArray(a.image_paths) ? str(a.image_paths[0]) : undefined);
  const after = Array.isArray(r?.paths) ? (r.paths as unknown[]).filter((p): p is string => typeof p === 'string') : [];
  if (!r?.success || !before || !before.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(before) || after.length === 0) return undefined;
  return { kind: 'image_edit', before, after, instruction: str(a.prompt) };
};

/* ── 团队 ── team_roster 入参 {members:[{id,role,title}]}; list_agents {agents:[{name,description,status}]} */
const team: Parser = (a, out, e) => {
  const t = (e.toolName || '').toLowerCase();
  if (t === 'team_roster' && Array.isArray(a.members)) {
    const members = (a.members as Args[]).map((m) => ({
      name: str(m?.title) ?? str(m?.role) ?? str(m?.id) ?? '?',
      action: str(m?.role),
      state: 'idle' as const,
    }));
    return members.length ? { kind: 'team', members } : undefined;
  }
  if (t === 'list_agents') {
    const r = json(out);
    if (!Array.isArray(r?.agents) || r.agents.length === 0) return undefined;
    const members = (r.agents as Args[]).map((m) => {
      const st = String(m?.status ?? '');
      return {
        name: str(m?.name) ?? str(m?.agentId) ?? '?',
        action: str(m?.description),
        state: (/run|work|busy/.test(st) ? 'running' : /done|complete|finish/.test(st) ? 'done' : /fail|error/.test(st) ? 'failed' : 'idle') as 'running' | 'done' | 'failed' | 'idle',
      };
    });
    return { kind: 'team', members };
  }
  if (t === 'send_message') {
    const to = str(a.to) ?? str(a.agent) ?? str(a.agent_id) ?? str(a.recipient);
    const text = str(a.message) ?? str(a.content) ?? str(a.text);
    return to && text ? { kind: 'team_message', to, text: clip(text, 120) } : undefined;
  }
  return undefined;
};

/* ── 日程 ── calendar_add {title,start,duration_minutes,location} (T/macosBridgeTools.ts:200) */
const calendar: Parser = (a, out) => {
  const r = json(out);
  if (r?.error) return undefined;
  const title = str(a.title);
  const start = str(a.start);
  if (!title || !start) return undefined;
  const mins = num(a.duration_minutes);
  const d = new Date(start);
  const end = mins && !Number.isNaN(d.getTime()) ? new Date(d.getTime() + mins * 60_000).toISOString() : undefined;
  return { kind: 'calendar', title, start, end, location: str(a.location) };
};

/* ── 发消息 ── send_imessage {ok,message} (T/macosBridgeTools.ts:569) */
const message: Parser = (a, out) => {
  const r = json(out);
  if (!r?.ok) return undefined;
  const to = str(a.to) ?? str(a.recipient) ?? str(a.name) ?? '';
  const text = str(a.message) ?? str(a.text) ?? str(a.body);
  if (!text) return undefined;
  const now = new Date();
  return { kind: 'message', to, text, channel: 'iMessage', status: '已送达', at: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` };
};

/* ── 方案 ── exit_plan_mode 入参 {plan: markdown} —— 编号 / 列表行就是步骤 */
const plan: Parser = (a) => {
  const md = str(a.plan) ?? str(a.content);
  if (!md) return undefined;
  const steps = md.split('\n')
    .map((l) => /^\s*(?:\d+[.)、]|[-*•])\s+(.+)$/.exec(l)?.[1]?.replace(/\*\*/g, '').trim())
    .filter((s): s is string => !!s);
  if (steps.length === 0) return undefined;
  const files = new Set(md.match(/[\w./-]+\.(?:tsx?|jsx?|css|py|go|rs|java|md|json)\b/g) ?? []).size;
  return { kind: 'plan', steps, files: files || undefined, awaiting: true };
};

/* ── 资料库 ── knowledge_search 文本: `命中 N 条` / `### 标题` / `path:` / 片段 (T/knowledgeTool.ts:152) */
const knowledge: Parser = (a, out) => {
  const text = body(out);
  if (!/^命中 \d+ 条/.test(text)) return undefined;
  const hits: Array<{ title: string; snippet: string; where?: string }> = [];
  for (const block of text.split(/\n### /).slice(1)) {
    const lines = block.split('\n');
    const title = lines[0]!.replace(/\s*\[.*?\]\s*$/, '').trim();
    const path = lines.find((l) => l.startsWith('path: '))?.slice(6).trim();
    const snippet = lines.filter((l) => l.trim() && !/^(path|source): /.test(l)).slice(1).join(' ').replace(/\s+/g, ' ').trim();
    if (title) hits.push({ title, snippet: clip(snippet, 160), where: path && path !== title ? path.split(/[\\/]/).pop() : undefined });
  }
  return hits.length ? { kind: 'knowledge', query: str(a.query) ?? '', hits } : undefined;
};

/* ── 记忆 ── memory {action: write|search} / update_profile (T/unifiedMemoryTool.ts) */
const memory: Parser = (a, out, e) => {
  const t = (e.toolName || '').toLowerCase();
  const text = body(out);
  if (t === 'memory' || t === 'unified_memory') {
    const action = str(a.action);
    if ((action === 'write' || action === 'update_project') && text.startsWith('✓')) {
      return { kind: 'memory', op: 'save', text: clip(str(a.content) ?? '', 80), scope: action === 'update_project' ? '项目记忆' : undefined };
    }
    if (action === 'search' && str(a.query) && !text.startsWith('未找到') && !text.startsWith('搜索失败')) {
      const count = text.split('\n').filter((l) => /^\s*(?:[-*•]|\d+\.)\s/.test(l)).length;
      return { kind: 'memory', op: 'recall', text: str(a.query)!, count: count || undefined };
    }
  }
  if (t === 'update_profile') {
    const r = json(out);
    const added = str(r?.added) ?? str(a.fact) ?? str(a.content);
    return r?.ok && added ? { kind: 'memory', op: 'save', text: clip(added, 80), scope: '个人信息' } : undefined;
  }
  return undefined;
};

/* ── 测试: run_tests 的输出里认 vitest / jest / pytest / go 的汇总行 ── */
function parseTestSummary(text: string): { passed: number; failed: number; skipped?: number } | undefined {
  const t = text.replace(/\x1b\[[0-9;]*m/g, '');
  let m = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed(?:\s*\|\s*(\d+) skipped)?/.exec(t);              // vitest
  if (m) return { failed: Number(m[1] ?? 0), passed: Number(m[2]), skipped: m[3] ? Number(m[3]) : undefined };
  m = /Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(\d+) passed/.exec(t);                         // jest
  if (m) return { failed: Number(m[1] ?? 0), skipped: m[2] ? Number(m[2]) : undefined, passed: Number(m[3]) };
  m = /=+ (?:(\d+) failed,?\s*)?(\d+) passed(?:,?\s*(\d+) skipped)?/.exec(t);                               // pytest
  if (m) return { failed: Number(m[1] ?? 0), passed: Number(m[2]), skipped: m[3] ? Number(m[3]) : undefined };
  m = /=+ (\d+) failed in/.exec(t);
  if (m) return { failed: Number(m[1]), passed: 0 };
  const pass = /^# pass (\d+)$/m.exec(t);                                                                  // node:test / TAP
  const fail = /^# fail (\d+)$/m.exec(t);
  if (pass && fail) {
    const skip = /^# skipped (\d+)$/m.exec(t);
    return { passed: Number(pass[1]), failed: Number(fail[1]), skipped: skip && Number(skip[1]) ? Number(skip[1]) : undefined };
  }
  return undefined;
}
function parseTestFailures(text: string): Array<{ name: string; expected?: string; actual?: string; message?: string }> {
  const t = text.replace(/\x1b\[[0-9;]*m/g, '');
  const out: Array<{ name: string; expected?: string; actual?: string; message?: string }> = [];
  const re = /(?:FAIL|✕|×|FAILED|^not ok \d+ -)\s+(.+?)(?:\n|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) && out.length < 6) {
    const name = m[1]!.trim().replace(/\s+\d+ms$/, '');
    if (!name || out.some((f) => f.name === name)) continue;
    const tail = t.slice(m.index, m.index + 800);
    const exp = /Expected:?\s+(.+)/.exec(tail)?.[1]?.trim();
    const act = /(?:Received|Actual):?\s+(.+)/.exec(tail)?.[1]?.trim();
    const msg = /(?:Error|AssertionError)[^\n]*/.exec(tail)?.[0]?.trim();
    out.push({ name: clip(name, 120), expected: exp && clip(exp, 120), actual: act && clip(act, 120), message: !exp && msg ? clip(msg, 140) : undefined });
  }
  return out;
}
const tests: Parser = (_a, out) => {
  /* run_tests 回的是 summarized 信封, 日志在 metadata.output_tail (runtimeStructuredCommandTools.ts), 不在 content */
  const tail = unwrapContextualOutput(out)?.metadata?.output_tail;
  const text = typeof tail === 'string' && tail ? tail : body(out);
  const sum = parseTestSummary(text);
  if (!sum) return undefined;
  /* 原始输出一并带上: 卡替掉了终端块, 不能让人再也看不到完整日志 */
  return { kind: 'tests', ...sum, failures: sum.failed ? parseTestFailures(text) : [], raw: text.slice(-8000) };
};

/* ── Git: git_status 正文是 `git status -sb` (T/git/runtimeGitTools.ts:49) ── */
const gitStatus: Parser = (_a, out) => {
  const env = unwrapContextualOutput(out);
  if (!env || env.status === 'error') return undefined;
  const text = env.content ?? '';
  const lines = text.split('\n');
  const head = /^## (\S+?)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?,?\s*(?:behind (\d+))?\])?$/.exec(lines[0] ?? '');
  const files = lines.slice(head ? 1 : 0)
    .map((l) => /^(.{2}) (.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ status: m[1]!.trim() || 'M', path: m[2]!.trim() }));
  if (!head && files.length === 0) return text.includes('clean') ? { kind: 'git_status', files: [] } : undefined;
  return { kind: 'git_status', branch: head?.[1], ahead: head?.[2] ? Number(head[2]) : undefined, behind: head?.[3] ? Number(head[3]) : undefined, files };
};

/* ── 查问题: read_lints {count,diagnostics:[{path,line,severity,message,source,code}]} ── */
const diagnostics: Parser = (_a, out) => {
  const r = json(out);
  if (!Array.isArray(r?.diagnostics) || r.diagnostics.length === 0) return undefined;
  const items = (r.diagnostics as Args[]).map((d) => ({
    file: str(d.path) ?? '',
    line: num(d.line),
    severity: (d.severity === 'warning' ? 'warning' : d.severity === 'error' ? 'error' : 'info') as 'error' | 'warning' | 'info',
    message: str(d.message) ?? '',
    rule: [str(d.source), str(d.code)].filter(Boolean).join('/') || undefined,
  })).filter((d) => d.file && d.message);
  return items.length ? { kind: 'diagnostics', items } : undefined;
};

/* ── 找引用: get_references 正文按 `file:line: text` 列 ── */
const refs: Parser = (a, out) => {
  const text = body(out);
  const items: Array<{ file: string; line?: number; tag?: 'def' | 'call' | 'ref'; text?: string }> = [];
  for (const l of text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?([^\s:][^:]*\.[a-z]{1,5}):(\d+)(?::\d+)?[:\s-]+(.*)$/i.exec(l);
    if (!m) continue;
    const code = m[3]!.trim();
    const tag = /\b(function|class|const|let|interface|type|def)\b/.test(code) ? 'def' : /\(/.test(code) ? 'call' : 'ref';
    items.push({ file: m[1]!, line: Number(m[2]), tag, text: clip(code, 80) });
    if (items.length >= 30) break;
  }
  return items.length ? { kind: 'refs', symbol: str(a.query), items } : undefined;
};

/* ── 启动服务: run_dev_server {status,command,message,url?} (T/shell/runDevServerTool.ts:85) ── */
const service: Parser = (a, out) => {
  const r = json(out);
  if (!r || typeof r.status !== 'string') return undefined;
  const url = str(r.url) ?? /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"']*/.exec(JSON.stringify(r))?.[0];
  const ok = /running|ready|started|success/.test(r.status);
  return {
    kind: 'service',
    name: str(r.command) ?? str(a.command) ?? 'dev server',
    url,
    pid: num(r.pid),
    status: ok ? 'running' : /fail|error/.test(r.status) ? 'failed' : 'stopped',
  };
};

/* ── Python: 入参代码 + 输出正文 ── */
const python: Parser = (a, out) => {
  const code = str(a.code);
  if (!code || (str(a.language) && !/py/i.test(String(a.language)))) return undefined;
  const text = body(out).replace(/^```\w*\n?|```$/g, '').trim();
  const images = (text.match(/\/[^\s"'`]+\.(?:png|jpe?g|svg)/g) ?? []).slice(0, 2);
  return { kind: 'python', code, stdout: text ? clip(text, 3000) : undefined, images: images.length ? images : undefined };
};

/* ── 定时 / 提醒 ── cron_create 入参 {schedule|cron, prompt}; schedule_reminder 已有 timer_card, 不重复 */
const cron: Parser = (a, out) => {
  const r = json(out);
  if (r?.error) return undefined;
  const when = str(a.cron) ?? str(a.schedule) ?? str(a.expression);
  const what = str(a.prompt) ?? str(a.task) ?? str(a.description) ?? str(a.name);
  return when && what ? { kind: 'schedule', when: cronToHuman(when, isZhUi()), what: clip(what, 80), next: str(r?.next_run) ?? str(r?.nextRun) } : undefined;
};

/* ── 路线 ── maps {action:'route'} → {success,result} (T/mapsTool.ts:167) */
const maps: Parser = (a, out) => {
  if (str(a.action) !== 'route') return undefined;
  const r = json(out);
  if (!r?.success || !r.result) return undefined;
  const res = r.result as Args;
  const secs = num(res.duration) ?? num(res.duration_s) ?? num(res.durationSeconds);
  const mins = num(res.minutes) ?? (secs !== undefined ? Math.round(secs / 60) : undefined);
  const summary = str(res.summary) ?? str(res.mode) ?? str(a.mode);
  const dist = num(res.distance) ?? num(res.distance_m);
  return {
    kind: 'route',
    from: str(a.origin) ?? str(a.from),
    to: str(a.destination) ?? str(a.to),
    minutes: mins,
    summary,
    detail: dist !== undefined ? `${(dist / 1000).toFixed(1)} km` : undefined,
  };
};

/* ── 找工具 ── tool_search 目录文本里的工具名 */
const toolSearch: Parser = (_a, out) => {
  const text = body(out);
  const names = Array.from(new Set((text.match(/^\s*(?:[-*•]\s*)?`?([a-z][a-z0-9_]{2,})`?\s*(?:[—:-]|\()/gim) ?? [])
    .map((l) => /([a-z][a-z0-9_]{2,})/i.exec(l)?.[1] ?? '')
    .filter(Boolean)));
  return names.length ? { kind: 'tool_search', tools: names.slice(0, 24) } : undefined;
};

/* ── MCP: mcp__server__tool, 参数 / 结果都是 JSON 时按键值列 ── */
function toKV(obj: unknown): KV[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.entries(obj as Args).slice(0, 12).map(([k, v]) => ({
    k,
    v: typeof v === 'string' ? clip(v, 140) : clip(JSON.stringify(v) ?? '', 140),
  }));
}
function mcpCard(entry: TimelineEntry): ToolCard | undefined {
  const raw = entry.toolName || '';
  const m = /^mcp__(.+?)__(.+)$/.exec(raw);
  if (!m) return undefined;
  const r = json(entry.output ?? '');
  const parts = Array.isArray(r) ? (r as Array<Record<string, unknown>>) : undefined;
  const fromParts = parts?.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => String(p.text)).join('\n\n');
  const text = (fromParts || (r === undefined ? body(entry.output ?? '') : '') || '').trim();
  const result = parts ? [] : toKV(r);
  const params = toKV(entry.toolArgs);
  if (params.length === 0 && result.length === 0 && !text) return undefined;
  return {
    kind: 'mcp', server: m[1], tool: m[2]!, params, result,
    text: text ? clip(text, 6000) : undefined,
    raw: r !== undefined ? JSON.stringify(r, null, 2) : undefined,
  };
}

const PARSERS: Record<string, Parser> = {
  deck_begin: slides, create_slides: slides, deck_export: slides,
  pptx_read: readDoc, sheet_describe: readDoc, word_describe: readDoc,
  share_page: share,
  render_video: video,
  edit_image: editImage,
  team_roster: team, list_agents: team, send_message: team,
  calendar_add: calendar,
  send_imessage: message,
  exit_plan_mode: plan,
  knowledge_search: knowledge,
  memory: memory, unified_memory: memory, update_profile: memory,
  run_tests: tests,
  git_status: gitStatus,
  read_lints: diagnostics, get_diagnostics: diagnostics, read_diagnostics: diagnostics,
  get_references: refs,
  run_dev_server: service,
  execute_python: python, execute_code: python,
  cron_create: cron,
  maps: maps,
  tool_search: toolSearch,
  ...EXTRA_PARSERS,
};

/** 这些卡说的是代码 / 命令 / JSON —— Work 模式不出 (设计稿: Work 走白话标题和成品卡) */
const CODE_ONLY = new Set<ToolCard['kind']>(['tests', 'git_status', 'git_log', 'refs', 'diagnostics', 'service', 'python', 'tool_search', 'mcp',
  'commit', 'branch', 'blame', 'monitor', 'context']);

/** 设计稿里有卡的工具 → StepContent; 不认识 / 解不出 / 还在跑 / 失败 → undefined */
export function buildToolCardContent(entry: TimelineEntry, agentMode?: string): StepContent | undefined {
  if (entry.type !== 'tool_result' && entry.type !== 'tool_call') return undefined;
  if (entry.pending || entry.success === false || !entry.output) return undefined;
  try {
    const name = (entry.toolName || '').toLowerCase();
    const parser = PARSERS[name];
    const card = parser ? parser((entry.toolArgs ?? {}) as Args, entry.output, entry) : mcpCard(entry);
    if (card && agentMode === 'work' && CODE_ONLY.has(card.kind)) return undefined;
    return card ? { type: 'tool_card', card } : undefined;
  } catch {
    return undefined;
  }
}

export const __testing = { parseTestSummary, parseTestFailures };
