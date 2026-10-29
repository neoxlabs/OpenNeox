import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/** 跟 CLI membershipCache.ts 的 CACHE_VERSION 对齐 (2 = 窗口限额制) */
const CACHE_VERSION = 2;

export function writeMembershipCache(membership: unknown, accountKey: string): void {
  if (!membership || typeof membership !== 'object') return;
  try {
    const dir = join(homedir(), NEOX_HOME_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'membership-cache.json');
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, accountKey, fetchedAt: Date.now(), data: membership }), 'utf-8');
    renameSync(tmp, file);
  } catch {
    /* 落盘失败不影响桌面端自己的内存态, 下次刷新再写 */
  }
}
