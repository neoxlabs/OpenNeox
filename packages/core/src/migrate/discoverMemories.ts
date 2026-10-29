
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { MemoryCategory } from '@neoxlabs/platform/platform/memory/types.js';

export type ExternalMemorySource = 'Claude Code' | 'Codex' | 'Hermes';

export interface ExternalMemoryCandidate {
  /** 来源 + 正文的稳定哈希 —— UI 勾选用 */
  key: string;
  source: ExternalMemorySource;
  /** 这条是从哪个文件读出来的 —— 让用户能自己去核对 */
  sourcePath: string;
  /** 小节标题 / 记忆文件的 name, 没有就空 */
  title: string;
  /** 写进 Neox 记忆的正文 */
  summary: string;
  category: MemoryCategory;
  /** 当前工作区里已经有一条正文相同的 */
  alreadyImported: boolean;
}

/** 单条上限: 记忆是要进上下文的, 一整份几千字的指令文件当一条会把注入预算吃光 */
const MAX_SUMMARY_CHARS = 1500;

export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Claude Code 存项目数据的目录名: 绝对路径里非字母数字一律换成 '-' */
export function claudeProjectSlug(workDir: string): string {
  return path.resolve(workDir).replace(/[^a-zA-Z0-9]/g, '-');
}

function readText(file: string): string | null {
  try {
    if (!fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf-8');
  } catch { return null; }
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_SUMMARY_CHARS ? `${t.slice(0, MAX_SUMMARY_CHARS).trimEnd()}…` : t;
}

/** 剥 YAML frontmatter, 顺手读出顶层和 metadata 下的标量 (name / description / type) */
export function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv || !kv[2]) continue;
    const v = kv[2].trim();
    meta[kv[1]] = /^".*"$/.test(v)
      ? v.slice(1, -1).replace(/\\(["\\])/g, '$1')
      : v.replace(/^'(.*)'$/, '$1');
  }
  return { meta, body: raw.slice(m[0].length) };
}

/** 按 ## 小节拆; 没有小节的整份当一条。小节标题保留在正文开头, 脱离原文件也看得懂 */
export function splitMarkdownSections(raw: string): Array<{ title: string; text: string }> {
  const lines = raw.split(/\r?\n/);
  const out: Array<{ title: string; lines: string[] }> = [];
  let cur: { title: string; lines: string[] } = { title: '', lines: [] };
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push(cur);
      cur = { title: h[1], lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  out.push(cur);
  return out
    .map((s) => ({ title: s.title, text: s.lines.join('\n').trim() }))
    /* 只剩一行 # 大标题的前言不算一条 */
    .filter((s) => s.text && !/^#\s+[^\n]*$/.test(s.text));
}

/** Hermes 的记忆文件: 条目之间是单独一行的 § */
export function splitHermesEntries(raw: string): string[] {
  return raw.split(/^\s*§\s*$/m).map((s) => s.trim()).filter(Boolean);
}

/** Claude Code 自动记忆的 type → Neox 的分类 */
function categoryForClaudeType(type: string | undefined): MemoryCategory {
  switch (type) {
    case 'user': return 'pinned';       /* 用户是谁、偏好 —— 一直该在 */
    case 'feedback': return 'lesson';   /* 被纠正过的做法 */
    case 'project': return 'progress';  /* 进行中的工作 */
    default: return 'standard';         /* reference 及其它 */
  }
}

export interface DiscoverMemoriesOptions {
  workDir?: string;
  homeDir?: string;
  /** 当前工作区已有记忆的正文 —— 用来标 alreadyImported */
  existing?: Iterable<string>;
  env?: NodeJS.ProcessEnv;
}

export function discoverExternalMemories(opts: DiscoverMemoriesOptions = {}): ExternalMemoryCandidate[] {
  const home = opts.homeDir ?? os.homedir();
  const env = opts.env ?? process.env;
  const existing = new Set(Array.from(opts.existing ?? [], normalizeMemoryText));
  const out: ExternalMemoryCandidate[] = [];
  const seen = new Set<string>();

  const push = (source: ExternalMemorySource, sourcePath: string, title: string, text: string, category: MemoryCategory) => {
    const summary = clip(text);
    if (!summary) return;
    const norm = normalizeMemoryText(summary);
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push({
      key: `${source}:${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12)}`,
      source,
      sourcePath,
      title,
      summary,
      category,
      alreadyImported: existing.has(norm),
    });
  };

  const pushSections = (source: ExternalMemorySource, file: string, category: MemoryCategory) => {
    const raw = readText(file);
    if (!raw) return;
    for (const s of splitMarkdownSections(splitFrontmatter(raw).body)) push(source, file, s.title, s.text, category);
  };

  const listMd = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir)
        /* MEMORY.md 和 MEMORY_archive_*.md 都是索引 (一行一个链接), 不是记忆本身 */
        .filter((n) => n.toLowerCase().endsWith('.md') && !/^memory([_.-]|$)/i.test(n))
        .sort()
        .map((n) => path.join(dir, n));
    } catch { return []; }
  };

  /* ── Claude Code ── */
  pushSections('Claude Code', path.join(home, '.claude', 'CLAUDE.md'), 'pinned');
  if (opts.workDir) {
    const memDir = path.join(home, '.claude', 'projects', claudeProjectSlug(opts.workDir), 'memory');
    for (const file of listMd(memDir)) {
      const raw = readText(file);
      if (!raw) continue;
      const { meta, body } = splitFrontmatter(raw);
      const title = meta.name ?? path.basename(file, '.md');
      /* description 是一句话摘要, 正文是细节 —— 两样都带上, 正文为空就只留摘要 */
      const text = [meta.description, body.trim()].filter(Boolean).join('\n\n');
      push('Claude Code', file, title, text, categoryForClaudeType(meta.type));
    }
  }

  /* ── Codex ── */
  pushSections('Codex', path.join(home, '.codex', 'AGENTS.md'), 'pinned');
  for (const file of listMd(path.join(home, '.codex', 'memories'))) pushSections('Codex', file, 'standard');

  /* ── Hermes ── */
  const hermesHome = env.HERMES_HOME?.trim() || path.join(home, '.hermes');
  for (const [name, category] of [['USER.md', 'pinned'], ['MEMORY.md', 'standard']] as const) {
    const file = path.join(hermesHome, 'memories', name);
    const raw = readText(file);
    if (!raw) continue;
    for (const entry of splitHermesEntries(raw)) push('Hermes', file, '', entry, category);
  }

  return out;
}

/** 写进当前工作区记忆。sink 就是 ActionLogService —— 只要它的 addMemoryItem, 不在这里依赖整个服务 */
export function importExternalMemories(
  sink: { addMemoryItem(item: { category: MemoryCategory; summary: string; confidence?: number; tags?: string[] }): void },
  picked: ExternalMemoryCandidate[],
): number {
  let n = 0;
  for (const c of picked) {
    if (c.alreadyImported) continue;
    sink.addMemoryItem({
      category: c.category,
      summary: c.summary,
      /* 用户自己攒的, 不是模型猜的 —— 给满, 免得被低置信过滤掉 */
      confidence: 1,
      tags: ['imported', c.source.toLowerCase().replace(/\s+/g, '-')],
    });
    n++;
  }
  return n;
}
