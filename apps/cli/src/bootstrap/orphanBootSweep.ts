
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { reapOrphanBackgroundProcesses } from '@neoxlabs/platform/platform/orphanReaper.js';
import { L } from '../i18n/index.js';

/** 列表最多写几条 —— 一行提示不该刷屏 */
const MAX_LISTED = 5;

function shortCommand(command: string): string {
  const oneLine = command.trim().replace(/\s+/g, ' ');
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

export interface OrphanBootSweepOptions {
  /** --keep-orphans: 只列不杀 */
  keep: boolean;
  /** --json / print 模式: 输出走 stderr, 不能弄脏 stdout */
  toStderr?: boolean;
  /** 覆盖 run 目录 (测试用)。默认 `~/.neox/run`。 */
  runDir?: string;
}

/**
 * 启动清扫。失败只记日志, 绝不阻断启动 —— 清不掉孤儿不该让 CLI 起不来。
 */
export async function sweepOrphanBackgroundProcesses(options: OrphanBootSweepOptions): Promise<void> {
  /* 告诉同进程的 server boot 收尸不要再杀 —— 否则 --keep-orphans 刚保留完, 200ms
   * 后 server 启动又给杀了。 */
  if (options.keep) process.env.NEOX_KEEP_ORPHANS = '1';

  try {
    const result = await reapOrphanBackgroundProcesses({ keep: options.keep, runDir: options.runDir });
    if (result.orphans.length === 0) return;

    const listed = result.orphans.slice(0, MAX_LISTED).map(o => `${shortCommand(o.command)} (pid ${o.pid})`);
    const more = result.orphans.length > MAX_LISTED
      ? L(` 等 ${result.orphans.length} 个`, ` and ${result.orphans.length} total`)
      : '';
    const count = result.orphans.length;
    const line = options.keep
      ? L(`上次留下 ${count} 个后台进程, 已按 --keep-orphans 保留: ${listed.join(', ')}${more}`,
        `${count} background process(es) left from last run, kept by --keep-orphans: ${listed.join(', ')}${more}`)
      : L(`清理了 ${count} 个上次留下的后台进程: ${listed.join(', ')}${more}`,
        `Cleaned up ${count} background process(es) left from last run: ${listed.join(', ')}${more}`);

    (options.toStderr ? process.stderr : process.stdout).write(`${line}\n`);
    cliLogger.info('ORPHAN_REAPER', `${options.keep ? 'kept' : 'reaped'} ${count} orphan(s)`);
  } catch (err: any) {
    cliLogger.warn('ORPHAN_REAPER', `startup sweep failed: ${err?.message ?? err}`);
  }
}
