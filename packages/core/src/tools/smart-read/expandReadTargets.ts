import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';

const execFileP = promisify(execFile);

/** 读进来没用的: 锁文件 / 二进制 / 媒体 / 压缩包 */
const SKIP_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock']);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|o|a|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|webm|wav|flac|sqlite|db|pyc|map|min\.js)$/i;
const MAX_FILE_BYTES = 200_000;
const WALK_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/coverage/**', '**/target/**', '**/.venv/**', '**/__pycache__/**'];

const isGlob = (p: string) => /[*?[\]{}]/.test(p);

async function trackedFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

async function keep(root: string, rel: string): Promise<boolean> {
  if (SKIP_NAMES.has(path.basename(rel)) || SKIP_EXT.test(rel)) return false;
  try {
    const st = await fs.stat(path.resolve(root, rel));
    return st.isFile() && st.size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

/**
 * @returns files 要读的路径 (相对工作区或原样的绝对路径); expanded 是否真的展开过目录/通配符
 */
export async function expandReadTargets(entries: string[], root: string): Promise<{ files: string[]; expanded: boolean }> {
  const out: string[] = [];
  const seen = new Set<string>();
  let tracked: string[] | null | undefined;
  let expanded = false;
  const push = (p: string) => { if (!seen.has(p)) { seen.add(p); out.push(p); } };

  for (const raw of entries) {
    const entry = raw.trim().replace(/\/+$/, '') || '.';
    const abs = path.resolve(root, entry);
    const dir = !isGlob(entry) && await fs.stat(abs).then((s) => s.isDirectory()).catch(() => false);
    if (!dir && !isGlob(entry)) { push(raw); continue; }
    expanded = true;

    if (tracked === undefined) tracked = await trackedFiles(root);
    let candidates: string[];
    const relEntry = path.relative(root, abs).split(path.sep).join('/');
    if (tracked) {
      if (dir) {
        candidates = relEntry === '' ? tracked : tracked.filter((f) => f === relEntry || f.startsWith(`${relEntry}/`));
      } else {
        const re = globToRegExp(entry.replace(/^\.\//, ''));
        candidates = tracked.filter((f) => re.test(f));
      }
    } else {
      candidates = (await glob(dir ? '**/*' : entry, { cwd: dir ? abs : root, nodir: true, ignore: WALK_IGNORE, dot: false }))
        .map((f) => (dir ? path.join(relEntry, f) : f).split(path.sep).join('/'));
    }
    for (const f of candidates.sort()) if (await keep(root, f)) push(f);
  }
  return { files: out, expanded };
}
