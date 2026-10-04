/**
 * 欢迎面板右栏的数据 (最近会话) —— main 在会话初始化之后、Ink 启动之前写一次, Header 首帧直接读。
 * 走模块级而不是一路 props: Header 在 <Static> 里只画一次, 这份数据也只需要启动那一刻的。
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCliEdition } from '../../edition/index.js';

export interface HeroRecentSession {
  title: string;
  ago: string;
}

let recent: HeroRecentSession[] = [];

export function setHeroRecentSessions(list: HeroRecentSession[]): void {
  recent = list.slice(0, 4);
}

/* 开屏额度条 —— 发行版插槽 (商业版读订阅缓存; 公开版没有)。同 notice, 只取一次 */
export type HeroUsage = { label: string; percent: number };
let usage: HeroUsage | null | undefined;

export function getHeroUsage(): HeroUsage | null {
  if (usage === undefined) {
    try { usage = getCliEdition().account?.heroUsage?.() ?? null; } catch { usage = null; }
  }
  return usage;
}

/* 当前 git 分支: 从 workDir 往上找 .git/HEAD 读一行 (不起 git 进程, 启动路径上不能等)。
 * worktree 的 .git 是文件 ("gitdir: …"), 跟过去读那边的 HEAD; detached 给短 hash。 */
const branchCache = new Map<string, string | null>();

export function getGitBranch(workDir: string): string | null {
  if (branchCache.has(workDir)) return branchCache.get(workDir)!;
  let result: string | null = null;
  try {
    let dir = path.resolve(workDir);
    for (let i = 0; i < 40; i++) {
      const dotGit = path.join(dir, '.git');
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit;
        if (fs.statSync(dotGit).isFile()) {
          const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
          if (m) gitDir = path.resolve(dir, m[1]!.trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        result = ref ? ref[1]! : head.slice(0, 7);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { result = null; }
  branchCache.set(workDir, result);
  return result;
}

export function getHeroRecentSessions(): HeroRecentSession[] {
  return recent;
}

/* 开屏公告 —— 发行版插槽提供 (商业版读 /api/v1/announcements 的磁盘缓存; 公开版没有)。
 * 第一次读时取一次, 之后固定 (hero 只画一次; 重吐 header 时别再触发一次后台刷新)。 */
export type HeroNotice = { title: string; severity: 'info' | 'warn' | 'critical'; link?: string | null };
let notice: HeroNotice | null | undefined;

export function getHeroNotice(): HeroNotice | null {
  if (notice === undefined) {
    try { notice = getCliEdition().account?.heroNotice?.() ?? null; } catch { notice = null; }
  }
  return notice;
}
