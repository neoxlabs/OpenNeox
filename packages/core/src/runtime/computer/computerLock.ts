
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

const FRONTMOST_KEY = '__frontmost__';

/** 每个 App 一条尾巴: 新任务接在上一个后面, 拿到的是"轮到我了"的 promise。 */
const tails = new Map<string, Promise<unknown>>();

function keyOf(app?: string): string {
  const t = (app ?? '').trim().toLowerCase();
  return t || FRONTMOST_KEY;
}

/**
 * 排队跑一段针对某个 App 的操作。同 App 串行, 不同 App 并行。
 *
 * @param app  目标 App (名字或 bundleId); 不给 = 前台
 * @param label 日志用, 出问题时能看出是谁在排队
 */
export async function withAppLock<T>(app: string | undefined, label: string, fn: () => Promise<T>): Promise<T> {
  const key = keyOf(app);
  const prev = tails.get(key);
  if (prev) {
    cliLogger.info('COMPUTER_LOCK', `${label} 排队等 ${key} 上一路跑完`);
  }

  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  /* 尾巴接上: 后来的等我。**必须先接上再 await 前一个** —— 反过来写的话, 两个同时
   * 进来会都看到同一个 prev、各自接在它后面, 那就是并行, 锁等于没有。 */
  const myTail = (prev ?? Promise.resolve()).then(() => mine, () => mine);
  tails.set(key, myTail);

  if (prev) { try { await prev; } catch { /* 上一路失败不该连累下一路 */ } }

  try {
    return await fn();
  } finally {
    release();
    /* 只有"当前尾巴还是我这条"时才清 —— 后面又排了人就不能删, 否则新来的看不到队伍。
     * 长会话里不清会让 Map 按操作过的 App 数无限涨。 */
    if (tails.get(key) === myTail) tails.delete(key);
  }
}

/** 当前有几个 App 上有排队 (诊断用) */
export function computerLockDepth(): number {
  return tails.size;
}

/** 测试用 */
export function __resetComputerLocks(): void {
  tails.clear();
}
