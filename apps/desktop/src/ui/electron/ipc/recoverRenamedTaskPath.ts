/**
 * 老会话里记的成品路径, 指向已经被改名的 Work 任务文件夹 —— 找回现在的位置。
 *
 * 10-18 合入的 work:Q-12 会在一轮做完后按模型标题改任务文件夹名 (10-19 已停用),
 * 但改名之前的会话, 时间线里成品卡记的是旧绝对路径, 点「在文件夹中显示」没反应。
 *
 * 做法: 路径不存在时, 取它在「工作」根下的那一级任务文件夹名的日期前缀 (YYYY-MM-DD),
 * 到同一个根下同日期开头的文件夹里, 按剩下的相对路径找; 唯一命中才算数。
 */
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { getNeoxUserRoot } from '@neoxlabs/core/runtime/modeHome.js';

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})\s/;

/** 老根 (v2: ~/Documents/Neox) 下的中文模式目录名 → v3 的英文名。 */
const LEGACY_ROOT_DIRS: Record<string, string> = {
  '工作': 'Work',
  '编码': 'Code',
  '领航': 'Pilot',
};

export function migrateLegacyRootPath(absPath: string): string | null {
  if (!absPath || existsSync(absPath)) return absPath || null;
  const oldRoot = path.join(homedir(), 'Documents', 'Neox');
  const rel = path.relative(oldRoot, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const [first, ...rest] = rel.split(path.sep);
  const renamed = first ? LEGACY_ROOT_DIRS[first] : undefined;
  if (!renamed) return null;
  const next = path.join(getNeoxUserRoot(), renamed, ...rest);
  return existsSync(next) ? next : null;
}

export function recoverRenamedTaskPath(absPath: string): string | null {
  if (!absPath || existsSync(absPath)) return absPath || null;
  /* 先试根目录搬家 (中文名也换成英文了), 再试同根下的任务改名 */
  const moved = migrateLegacyRootPath(absPath);
  if (moved) return moved;
  const parts = path.resolve(absPath).split(path.sep);
  for (let i = parts.length - 2; i > 0; i--) {
    const m = DATE_PREFIX.exec(parts[i]!);
    if (!m) continue;
    const root = parts.slice(0, i).join(path.sep) || path.sep;
    const tail = parts.slice(i + 1);
    let names: string[] = [];
    try { names = readdirSync(root); } catch { return null; }
    const hits = names
      .filter((n) => n !== parts[i] && n.startsWith(m[1]!))
      .map((n) => path.join(root, n, ...tail))
      .filter((p) => existsSync(p));
    return hits.length === 1 ? hits[0]! : null;
  }
  return null;
}
