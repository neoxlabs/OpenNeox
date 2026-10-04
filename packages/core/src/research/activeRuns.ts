/**
 * 正在跑的 deep_research —— 按会话登记, 让 list_agents 看得见、stop_agent 停得了。
 *
 * deep_research 整个跑在**一次工具调用内部**, 它的调研员对主 agent 来说只是一堆
 * 「调研: …」子 agent。没有这张表, 模型既说不清"是谁派的", 也没办法一刀停掉整轮
 * (一个个停 worker, 调度器马上又补派新的)。
 */

export interface ActiveDeepResearch {
  topic: string;
  startedAt: number;
  /** 整轮叫停: 不再派新角度 + 中止在飞的调研员 */
  stop: (reason: string) => void;
}

const runs = new Map<string, ActiveDeepResearch>();

export function registerDeepResearch(sessionId: string, run: ActiveDeepResearch): () => void {
  runs.set(sessionId, run);
  return () => { if (runs.get(sessionId) === run) runs.delete(sessionId); };
}

export function getActiveDeepResearch(sessionId: string): ActiveDeepResearch | undefined {
  return runs.get(sessionId);
}

const ranThisTurn = new Map<string, { topic: string; reportPath: string }>();

/** runtime.chat() 收到用户新的一句话时调 —— 续跑 / 重试 / 自动续推不算新的一句 */
export function beginUserTurnForResearch(sessionId: string): void {
  ranThisTurn.delete(sessionId);
}

export function markResearchRanThisTurn(sessionId: string, info: { topic: string; reportPath: string }): void {
  ranThisTurn.set(sessionId, info);
}

export function researchRanThisTurn(sessionId: string): { topic: string; reportPath: string } | undefined {
  return ranThisTurn.get(sessionId);
}

export function stopDeepResearch(sessionId: string, reason: string): boolean {
  const run = runs.get(sessionId);
  if (!run) return false;
  run.stop(reason);
  return true;
}
