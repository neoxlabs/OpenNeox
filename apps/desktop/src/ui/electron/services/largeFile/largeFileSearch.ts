/**
 * largeFileSearch —— 单文件 ripgrep 搜索.
 *
 * 给 LargeFileViewer 用. 跟 workspace 级 searchContent 区别:
 *   - 输入是单个文件路径, 不是 workspace root
 *   - 不受 `--max-filesize` 限制 (那个 flag 就是为了跳过 large file, 这里正相反)
 *   - 输出按行号升序 + 截断预览
 *
 * 流程: spawn rg → 逐行解析 JSON → 堆到结果数组 → 超阈值 kill.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { getRgPath } from '../../util/rgBinary.js';

export interface LargeFileMatch {
  line: number;          // 1-based
  column: number;        // 1-based
  preview: string;       // 截断到 500 字符
  matchStart: number;    // 行内字节 offset
  matchEnd: number;
}

export interface LargeFileSearchOptions {
  caseSensitive?: boolean;
  useRegex?: boolean;
  maxResults?: number;
}

const DEFAULT_MAX = 2000;

export async function searchLargeFile(
  filePath: string,
  query: string,
  opts: LargeFileSearchOptions = {},
): Promise<LargeFileMatch[]> {
  if (!query) return [];
  const rg = await getRgPath();
  const maxResults = opts.maxResults ?? DEFAULT_MAX;

  return new Promise<LargeFileMatch[]>((resolve, reject) => {
    const args: string[] = [
      '--json',
      '--no-heading',
      '--no-messages',
      '--color', 'never',
      '--mmap',
      '--max-columns', '500',
    ];
    if (!opts.caseSensitive) args.push('--ignore-case');
    if (!opts.useRegex) args.push('--fixed-strings');
    args.push('--', query, filePath);

    const child = spawn(rg, args, {
      env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const matches: LargeFileMatch[] = [];
    let killed = false;
    const kill = () => {
      if (!killed) { killed = true; try { child.kill('SIGTERM'); } catch { /* ignore */ } }
    };

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (matches.length >= maxResults) { kill(); return; }
      if (!line) return;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'match' || !obj.data) return;
        const d = obj.data;
        const lineText = typeof d.lines === 'object' ? d.lines.text : (d.lines || '');
        const submatches = d.submatches || [];
        const first = submatches[0] || { start: 0, end: 0 };
        matches.push({
          line: d.line_number || 0,
          column: (first.start || 0) + 1,
          preview: (lineText || '').replace(/\r?\n$/, '').slice(0, 500),
          matchStart: first.start || 0,
          matchEnd: first.end || 0,
        });
      } catch { /* non-match event */ }
    });

    child.on('error', reject);
    child.on('close', () => resolve(matches));
  });
}
