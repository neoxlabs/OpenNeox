import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  discoverExternalMemories,
  importExternalMemories,
  claudeProjectSlug,
  splitHermesEntries,
  splitMarkdownSections,
} from '../discoverMemories.js';

let home: string;
const write = (rel: string, content: string) => {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-mem-ext-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('discoverExternalMemories', () => {
  it('什么都没装时返回空数组而不是炸', () => {
    expect(discoverExternalMemories({ homeDir: home, workDir: '/x/y', env: {} })).toEqual([]);
  });

  it('Claude Code 本项目的自动记忆: 一个文件一条, 按 type 分类, 跳过 MEMORY.md 索引', () => {
    const workDir = '/Users/me/AI/Proj';
    const dir = `.claude/projects/${claudeProjectSlug(workDir)}/memory`;
    expect(claudeProjectSlug(workDir)).toBe('-Users-me-AI-Proj');
    write(`${dir}/MEMORY.md`, '- [a](a.md) — hook\n');
    write(`${dir}/MEMORY_archive_2026_09.md`, '- [b](b.md) — hook\n');
    write(`${dir}/user_lang.md`, '---\nname: reply-in-chinese\ndescription: 回复一律用中文\nmetadata:\n  type: feedback\n---\n\n英文汇报被要求改中文\n');
    write(`${dir}/who.md`, '---\nname: who\ndescription: "用户说\\"全栈\\""\ntype: user\n---\n');
    const found = discoverExternalMemories({ homeDir: home, workDir, env: {} });
    expect(found).toHaveLength(2);
    const fb = found.find((f) => f.title === 'reply-in-chinese')!;
    expect(fb.category).toBe('lesson');
    expect(fb.summary).toBe('回复一律用中文\n\n英文汇报被要求改中文');
    expect(found.find((f) => f.title === 'who')!.category).toBe('pinned');
    expect(found.find((f) => f.title === 'who')!.summary).toBe('用户说"全栈"');
  });

  it('别的项目的 Claude 记忆不读', () => {
    write('.claude/projects/-other/memory/x.md', '---\nname: x\ndescription: other\n---\n');
    expect(discoverExternalMemories({ homeDir: home, workDir: '/mine', env: {} })).toEqual([]);
  });

  it('全局 CLAUDE.md / AGENTS.md 按 ## 小节拆, 只有大标题的前言不算', () => {
    write('.claude/CLAUDE.md', '# 我的约定\n\n## 风格\n短句\n\n## 测试\n先跑单测\n');
    write('.codex/AGENTS.md', '直接一段没有小节的话');
    const found = discoverExternalMemories({ homeDir: home, env: {} });
    expect(found.filter((f) => f.source === 'Claude Code').map((f) => f.title)).toEqual(['风格', '测试']);
    const codex = found.filter((f) => f.source === 'Codex');
    expect(codex).toHaveLength(1);
    expect(codex[0].summary).toBe('直接一段没有小节的话');
    expect(codex[0].category).toBe('pinned');
  });

  it('Hermes: § 分隔的条目各算一条, USER.md 固定 / MEMORY.md 规范; 认 HERMES_HOME', () => {
    const hh = path.join(home, 'hh');
    fs.mkdirSync(path.join(hh, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(hh, 'memories', 'USER.md'), '喜欢深色主题\n§\n时区 UTC+8\n');
    fs.writeFileSync(path.join(hh, 'memories', 'MEMORY.md'), '项目用 pnpm\n§\n');
    const found = discoverExternalMemories({ homeDir: home, env: { HERMES_HOME: hh } });
    expect(found.map((f) => [f.summary, f.category])).toEqual([
      ['喜欢深色主题', 'pinned'],
      ['时区 UTC+8', 'pinned'],
      ['项目用 pnpm', 'standard'],
    ]);
  });

  it('当前工作区已有同样正文的标 alreadyImported (忽略空白和大小写)', () => {
    write('.hermes/memories/MEMORY.md', 'Use  PNPM\n§\nnew one');
    const found = discoverExternalMemories({ homeDir: home, env: {}, existing: ['use pnpm'] });
    expect(found.map((f) => f.alreadyImported)).toEqual([true, false]);
  });

  it('超长条目截到 1500 字', () => {
    write('.hermes/memories/MEMORY.md', 'x'.repeat(5000));
    const [f] = discoverExternalMemories({ homeDir: home, env: {} });
    expect(f.summary.length).toBe(1501);
    expect(f.summary.endsWith('…')).toBe(true);
  });
});

describe('importExternalMemories', () => {
  it('只写没导过的, 带来源标签, 置信度给满', () => {
    write('.hermes/memories/MEMORY.md', 'a\n§\nb');
    const found = discoverExternalMemories({ homeDir: home, env: {}, existing: ['a'] });
    const written: any[] = [];
    const n = importExternalMemories({ addMemoryItem: (i) => written.push(i) }, found);
    expect(n).toBe(1);
    expect(written).toEqual([{ category: 'standard', summary: 'b', confidence: 1, tags: ['imported', 'hermes'] }]);
  });
});

describe('拆分小工具', () => {
  it('splitHermesEntries 只认独占一行的 §', () => {
    expect(splitHermesEntries('a § b\n§\nc')).toEqual(['a § b', 'c']);
  });
  it('splitMarkdownSections 标题行留在正文里', () => {
    expect(splitMarkdownSections('## A\nx')).toEqual([{ title: 'A', text: '## A\nx' }]);
  });
});
