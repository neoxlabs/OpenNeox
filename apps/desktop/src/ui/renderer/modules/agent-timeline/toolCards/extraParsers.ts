/**
 * 10-21 补齐的工具卡解析 (设计稿「全部工具」里还没落地的): 提交 / 建分支 / 查来历 / 盯日志 / 上下文。
 * 单独一个文件, buildToolCard.ts 不再变长。天气已有 NeoxCard 天气卡 (mapTimeline get_weather → neox_card), 不重复。
 * 返回形状以 packages/core/src/tools 为准: git/runtimeGitTools.ts · monitorTools.ts · contextStatusTool.ts
 */
import type { TimelineEntry } from '../../../utils/workspaceUtils';
import { unwrapContextualOutput } from '../unwrapToolOutput';
import { stripToolHintHeader } from '../toolResultHint';
import type { ToolCard } from './toolCardTypes';

type Args = Record<string, unknown>;
export type Parser = (args: Args, out: string, entry: TimelineEntry) => ToolCard | undefined;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function json(out: string): any {
  const t = stripToolHintHeader((out || '').trim());
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}
/** contextual / ephemeral 信封 → { status, metadata, content } */
function env(out: string): { ok: boolean; md: Args; content: string } | undefined {
  const e = unwrapContextualOutput(out) as any;
  if (!e) return undefined;
  return { ok: e.status !== 'error' && !e.error, md: (e.metadata ?? {}) as Args, content: String(e.content ?? '') };
}

const commit: Parser = (a, out) => {
  const e = env(out);
  if (!e?.ok) return undefined;
  const message = str(e.md.message) ?? str(a.message);
  if (!message) return undefined;
  return {
    kind: 'commit', message: message.split('\n')[0]!, hash: str(e.md.hash), branch: str(e.md.branch),
    files: num(e.md.files), insertions: num(e.md.insertions), deletions: num(e.md.deletions),
  };
};

const branch: Parser = (a, out) => {
  const e = env(out);
  if (!e?.ok) return undefined;
  const name = str(e.md.branch) ?? str(a.name);
  return name ? { kind: 'branch', name, checkout: e.md.checkout === true || a.checkout === true } : undefined;
};

const BLAME_RE = /^\^?([0-9a-f]{7,40})(?:\s+\S+)?\s+\((.+?)\s+(\d{4}-\d{2}-\d{2})[^)]*?\s(\d+)\)\s?(.*)$/;
const blame: Parser = (a, out) => {
  const e = env(out);
  if (!e?.ok) return undefined;
  const rows = e.content.split('\n').map((l) => BLAME_RE.exec(l)).filter(Boolean).map((m) => ({
    hash: m![1]!.slice(0, 7), author: m![2]!.trim(), date: m![3]!, line: Number(m![4]), code: m![5] ?? '',
  }));
  const file = str(a.file_path) ?? str(a.path) ?? '';
  return rows.length ? { kind: 'blame', file, rows } : undefined;
};

const monitor: Parser = (_a, out, entry) => {
  const r = json(out);
  if (!r || r.status === 'error' || r.skipped) return undefined;
  const t = (entry.toolName || '').toLowerCase();
  if (t === 'monitor_start' && str(r.watching)) return { kind: 'monitor', op: 'start', watching: str(r.watching), id: str(r.monitor_id) };
  if (t === 'monitor_stop' && str(r.stopped)) return { kind: 'monitor', op: 'stop', id: str(r.stopped) };
  if (t === 'monitor_list' && Array.isArray(r.monitors)) {
    return { kind: 'monitor', op: 'list', items: (r.monitors as Args[]).map((m) => ({ watching: str(m.watching) ?? str(m.label) ?? '', fires: str(m.fires) })) };
  }
  return undefined;
};

const context: Parser = (_a, out) => {
  const r = json(out);
  if (!r || r.snapshot_available === false || !r.input) return undefined;
  const used = num(r.input.used_tokens), budget = num(r.input.budget_tokens);
  if (!used || !budget) return undefined;
  return { kind: 'context', pct: Math.min(100, Math.round((used / budget) * 100)), used, budget, compactAt: num(r.input.compression_triggers_at_tokens) };
};

export const EXTRA_PARSERS: Record<string, Parser> = {
  git_commit: commit,
  git_branch: branch,
  git_blame: blame,
  /* 文件改名 / 删除 / 建夹、进出 worktree 已有 op_chip (mapTimeline buildOpChipContent, 删除带撤销), 不重复 */
  monitor_start: monitor, monitor_stop: monitor, monitor_list: monitor,
  context_status: context,
};
