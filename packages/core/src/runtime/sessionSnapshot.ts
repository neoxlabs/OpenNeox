
import type { Tool } from '@neoxlabs/kernel/types/index.js';

export interface CacheSafeSnapshot {
  /** 父运行时最后一次实际送给 LLM 的 system prompt (含所有 layer + skills). */
  renderedSystemPrompt: string;
  /** 父运行时 ToolTreeEngine 输出的 liveTools (含 always-active + tool_search + call_tool). */
  liveTools: Tool[];
  /** 父运行时实际跑的 provider model name — sub-agent 复用同 model 才有 cache 共享. */
  model: string;
  /** 父运行时 workspacePath — 进 env info 层, 一致才不破 cache. */
  workspacePath: string;
  /** snapshot 第一次 set 的时间戳, 调试用. */
  capturedAt: number;
}

/** sessionId → snapshot. 一个 session 一份, sub-agent 用 parentSessionId 索引. */
const snapshots = new Map<string, CacheSafeSnapshot>();

/** GC 阈值. 总 session 数 > 此值时清最旧 ¼. */
const MAX_SESSIONS = 2000;

export function captureSessionSnapshot(sessionId: string, snapshot: Omit<CacheSafeSnapshot, 'capturedAt'>): void {
  if (!sessionId) return;
  /* sticky-on latch: 已 capture 过的不覆盖. 父 turn 改 system / tools / model 应该是
   * 显式 clearSessionSnapshot 之后再 capture, 不能默默 flip 把 sub-agent 的预期打散. */
  if (snapshots.has(sessionId)) return;
  snapshots.set(sessionId, { ...snapshot, capturedAt: Date.now() });

  if (snapshots.size > MAX_SESSIONS) {
    /* 清最旧 1/4. 用 Map 插入序作 LRU 近似. */
    const dropCount = Math.floor(MAX_SESSIONS / 4);
    let dropped = 0;
    for (const k of snapshots.keys()) {
      if (dropped >= dropCount) break;
      snapshots.delete(k);
      dropped++;
    }
  }
}

export function getSessionSnapshot(sessionId: string): CacheSafeSnapshot | undefined {
  if (!sessionId) return undefined;
  return snapshots.get(sessionId);
}

/** 显式清场 — Host 复用 / 用户 /clear / session 切 model 时 caller 主动调. */
export function clearSessionSnapshot(sessionId: string): void {
  snapshots.delete(sessionId);
}

/** 单测 / debug. */
export function resetAllSessionSnapshots(): void {
  snapshots.clear();
}
