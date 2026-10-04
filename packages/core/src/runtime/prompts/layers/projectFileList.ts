import { execSync } from 'node:child_process';

const MAX_FILES = 150;
const MAX_CHARS = 4000;
const cache = new Map<string, string>();

/** 按目录分组的紧凑清单: `src/: a.js b.js` 每个目录一行; 不是 git 仓库 / 太大 → '' */
export function projectFileList(workDir: string): string {
  const hit = cache.get(workDir);
  if (hit !== undefined) return hit;
  let result = '';
  try {
    const files = execSync('git ls-files', { cwd: workDir, encoding: 'utf-8', timeout: 1000, stdio: ['pipe', 'pipe', 'pipe'] })
      .split('\n').filter(Boolean);
    if (files.length > 0 && files.length <= MAX_FILES) {
      const byDir = new Map<string, string[]>();
      for (const f of files) {
        const i = f.lastIndexOf('/');
        const dir = i < 0 ? '' : f.slice(0, i + 1);
        byDir.set(dir, [...(byDir.get(dir) ?? []), f.slice(i + 1)]);
      }
      const lines = [...byDir].map(([dir, names]) => `  ${dir || './'}: ${names.join(' ')}`);
      const text = lines.join('\n');
      if (text.length <= MAX_CHARS) result = text;
    }
  } catch { /* 不是 git 仓库 / git 不可用 / 超时 → 不给 */ }
  cache.set(workDir, result);
  return result;
}
