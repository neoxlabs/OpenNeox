/**
 * turnBaselineRegistry — 每个 session「本轮开始前」的 Shadow Git commit
 *
 * 为什么需要它 (, 明康: "回滚不正确…要从架构级别彻底稳定住"):
 *   会话检查点 (对话) 和文件检查点 (Shadow Git) 是两套独立的 id, 各自都在 turn 开头产生:
 *     · RuntimeOrchestrator.runSession → checkpointService.startMessage() → 文件基线 commit
 *     · AgentRuntimeHost.runTask       → sessionSync.createCheckpoint('turn_N') → 对话检查点
 *   两者时间上只差几百毫秒, 但**没有任何字段把它们连起来**。结果就是用户点"回滚到 turn_5"
 *   时对话退回去了、磁盘纹丝不动 —— 代码是新的、对话是旧的, 两边对不上。
 *
 * 靠时间戳事后猜是不行的: 两个 commit 差不到 1 秒, 猜错一格就会把用户在两轮之间自己写的
 * 东西当成 AI 改动一起丢掉 (正是刚修完的那个数据丢失)。所以这里显式登记。
 *
 * 只在进程内存活。桌面/CLI 都是单进程 runtime, 两个写入方和读取方在同一个 module graph 里。
 * 拿不到就退化成"只裁对话", 跟改动之前的行为一致, 不会更糟。
 */

const baselines = new Map<string, string>();

/** orchestrator 在 startMessage 拿到 before commit 后登记。null/空 = 这轮没有文件基线。 */
export function setTurnFileBaseline(sessionId: string, commitId: string | null | undefined): void {
  if (!sessionId) return;
  if (commitId) baselines.set(sessionId, commitId);
  else baselines.delete(sessionId);
}

/** sessionSync 建对话检查点时读, 写进 CheckpointItem.fileCheckpointId。 */
export function getTurnFileBaseline(sessionId: string): string | undefined {
  return sessionId ? baselines.get(sessionId) : undefined;
}

export function clearTurnFileBaseline(sessionId: string): void {
  baselines.delete(sessionId);
}
