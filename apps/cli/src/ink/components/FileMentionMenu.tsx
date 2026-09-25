
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from '../../../vendor/ink/src/index.js';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NeoxTheme } from '../theme.js';
import { getLanguage } from '../../i18n/index.js';

const PAGE_SIZE = 8;
const MAX_FILES = 20000;
const CACHE_MS = 30_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.venv', 'venv', '__pycache__', 'target']);

let cache: { dir: string; at: number; files: string[] } | null = null;
let inflight: Promise<string[]> | null = null;

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let ents: import('node:fs').Dirent[];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(p); }
      else out.push(relative(root, p));
    }
  }
  return out;
}

function listFiles(dir: string): Promise<string[]> {
  if (cache && cache.dir === dir && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.files);
  if (inflight) return inflight;
  inflight = new Promise<string[]>((resolve) => {
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: dir, maxBuffer: 32 * 1024 * 1024, timeout: 3000 }, (err, stdout) => {
      const files = !err && stdout.trim()
        ? stdout.split('\n').filter(Boolean).slice(0, MAX_FILES)
        : walk(dir);
      cache = { dir, at: Date.now(), files };
      resolve(files);
    });
  }).finally(() => { inflight = null; });
  return inflight;
}

function score(path: string, q: string): number {
  if (!q) return 1;
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base.startsWith(q)) return 400 - p.length / 100;
  const i = p.indexOf(q);
  if (i >= 0) return 300 - i / 10 - p.length / 100;
  let k = 0;
  for (const ch of p) if (ch === q[k]) k++;
  return k === q.length ? 100 - p.length / 100 : -1;
}

export interface FileMentionMenuProps {
  query: string;
  workDir: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
  /** 没有候选时按回车: 按普通消息发送 */
  onSubmitInput: () => void;
}

export const FileMentionMenu: React.FC<FileMentionMenuProps> = ({ query, workDir, onSelect, onCancel, onSubmitInput }) => {
  const [files, setFiles] = useState<string[] | null>(cache && cache.dir === workDir ? cache.files : null);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    let alive = true;
    void listFiles(workDir).then(f => { if (alive) setFiles(f); });
    return () => { alive = false; };
  }, [workDir]);

  const matches = useMemo(() => {
    if (!files) return [];
    const q = query.toLowerCase();
    const scored: Array<[string, number]> = [];
    for (const f of files) {
      const s = score(f, q);
      if (s >= 0) scored.push([f, s]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, 50).map(x => x[0]);
  }, [files, query]);

  useEffect(() => { setSel(0); }, [query]);

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    /* 没有候选时回车照常发送 —— 输入框把回车让给了菜单, 这里不接就成了死键 */
    if (!matches.length) { if (key.return) onSubmitInput(); return; }
    if (key.upArrow) { setSel(s => (s > 0 ? s - 1 : matches.length - 1)); return; }
    if (key.downArrow) { setSel(s => (s < matches.length - 1 ? s + 1 : 0)); return; }
    if (key.tab || key.return) { onSelect(matches[sel]!); return; }
  });

  const zh = getLanguage() === 'zh';
  if (!files) return <Text color={NeoxTheme.text.dim}>{zh ? '  正在列出文件…' : '  Listing files…'}</Text>;
  if (!matches.length) return <Text color={NeoxTheme.text.dim}>{zh ? '  没有匹配的文件 · Esc 关闭' : '  No matching files · Esc to close'}</Text>;

  const start = Math.max(0, sel - PAGE_SIZE + 1);
  const shown = matches.slice(start, start + PAGE_SIZE);
  return (
    <Box flexDirection="column">
      {shown.map((f, i) => {
        const active = start + i === sel;
        const slash = f.lastIndexOf('/');
        return (
          <Box key={f}>
            <Text color={NeoxTheme.brand.purple}>{active ? '› ' : '  '}</Text>
            <Text color={active ? NeoxTheme.text.secondary : NeoxTheme.text.dim} wrap="truncate-start">{slash >= 0 ? f.slice(0, slash + 1) : ''}</Text>
            <Text color={active ? NeoxTheme.brand.purple : undefined} bold={active}>{f.slice(slash + 1)}</Text>
          </Box>
        );
      })}
      <Text color={NeoxTheme.text.dim}>
        {zh ? `  Tab / 回车 选中 · Esc 关闭 · ${matches.length}${matches.length >= 50 ? '+' : ''} 个` : `  Tab / Enter to insert · Esc to close · ${matches.length}${matches.length >= 50 ? '+' : ''}`}
      </Text>
    </Box>
  );
};
