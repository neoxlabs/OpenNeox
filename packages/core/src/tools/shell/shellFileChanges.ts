import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileP = promisify(execFile);
const MAX_FILES = 20;
export const FILES_WRITTEN_MARKER = '[files written]';

type Snapshot = { root: string; t0: number; dirty: Map<string, number> };

async function dirtyFiles(root: string): Promise<Map<string, number> | null> {
  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain', '-z', '-uall'], { cwd: root, timeout: 1500, maxBuffer: 8 << 20 });
    const out = new Map<string, number>();
    const entries = stdout.split('\0').filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const code = e.slice(0, 2);
      const rel = e.slice(3);
      if (code.startsWith('R') || code.startsWith('C')) i++;   /* 改名带旧路径一项 */
      if (code.includes('D')) continue;
      const st = await fs.stat(path.join(root, rel)).catch(() => null);
      if (st?.isFile()) out.set(rel, st.mtimeMs);
    }
    return out;
  } catch {
    return null;
  }
}

/** 写类命令执行前调用; 不是 git 仓库 / 超时 → null (之后什么都不报) */
export async function snapshotBeforeShell(root: string): Promise<Snapshot | null> {
  const dirty = await dirtyFiles(root);
  return dirty ? { root, t0: Date.now(), dirty } : null;
}

export async function filesWrittenSince(snap: Snapshot): Promise<string[]> {
  const after = await dirtyFiles(snap.root);
  if (!after) return [];
  const changed: string[] = [];
  for (const [rel, mtime] of after) {
    const before = snap.dirty.get(rel);
    if (before === undefined || mtime > before || mtime >= snap.t0) changed.push(rel);
    if (changed.length >= MAX_FILES) break;
  }
  return changed;
}

export function filesWrittenLine(files: string[]): string {
  return files.length ? `\n${FILES_WRITTEN_MARKER} ${JSON.stringify(files)}` : '';
}

/** 宿主侧: 从 shell 结果里取回文件列表 (没有就是空) */
export function parseFilesWritten(output: string): string[] {
  const i = output.lastIndexOf(FILES_WRITTEN_MARKER);
  if (i < 0) return [];
  const line = output.slice(i + FILES_WRITTEN_MARKER.length).split('\n')[0].trim();
  try {
    const list = JSON.parse(line);
    return Array.isArray(list) ? list.filter((f) => typeof f === 'string') : [];
  } catch {
    return [];
  }
}
