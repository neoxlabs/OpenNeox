import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import type { SessionTitleMeta } from '../runtime/sideAgentAdapter.js';

const KEY_PREFIX = 'sessionTitle:';

function keyOf(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/** 拿 DB —— 拿不到 (lite / 未初始化) 一律返回 null, 调用方按"没记过"走 */
async function db(): Promise<any | null> {
  try {
    const mod: any = await import('@neoxlabs/platform/platform/database.js');
    return mod.getDatabase?.() ?? null;
  } catch {
    return null;
  }
}

export async function readSessionTitleMeta(sessionId: string): Promise<SessionTitleMeta | null> {
  if (!sessionId) return null;
  try {
    const d = await db();
    const v = d?.getAppState?.(keyOf(sessionId));
    if (!v || typeof v !== 'object' || typeof v.title !== 'string') return null;
    return {
      title: v.title,
      aggregatedFromUserMessages: Number(v.aggregatedFromUserMessages) || 0,
      manual: v.manual === true,
    };
  } catch (err: any) {
    cliLogger.debug('SESSION_TITLE', `readSessionTitleMeta failed: ${err?.message}`);
    return null;
  }
}

export async function writeSessionTitleMeta(sessionId: string, meta: SessionTitleMeta): Promise<void> {
  if (!sessionId) return;
  try {
    const d = await db();
    d?.setAppState?.(keyOf(sessionId), meta);
  } catch (err: any) {
    cliLogger.debug('SESSION_TITLE', `writeSessionTitleMeta failed: ${err?.message}`);
  }
}

/** 会话被删时顺手清账 —— 不清也只是留一行几十字节, 但留着就是垃圾 */
export async function clearSessionTitleMeta(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    const d = await db();
    d?.deleteAppState?.(keyOf(sessionId));
  } catch { /* 清账失败不影响删会话 */ }
}
