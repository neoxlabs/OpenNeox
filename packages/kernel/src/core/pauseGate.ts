/**
 * 暂停闸 —— 让 agent 在**两轮之间**挂起再唤醒。
 *
 * ─── 跟"停止"完全是两回事, 别混 ────────────────────────────────────────────
 *   停止 = 这一轮作废。要接着干得重新发一遍, 上下文和已经做完的活可能白费。
 *   暂停 = 进程还在。恢复即从下一轮继续, 什么都不丢。
 *
 * ─── 为什么只有接口在 kernel ───────────────────────────────────────────────
 * kernel 不认识 core 的 PauseController (依赖方向是 core → kernel)。runner 只需要
 * "问一句停没停"和"挂起等唤醒"这两件事, 所以这里只留最小面, 实现放在
 * neox-core/runtime/pauseController.ts。不传 = 没有暂停能力, 循环照跑。
 *
 * ─── 安全点只能在循环顶部 ──────────────────────────────────────────────────
 * 调用它的位置必须满足: 上一轮 LLM 已经收完 + 这一轮所有工具都执行完 + 结果已经写进
 * messages。在流中间或工具执行中间挂起, 会留下半条消息 / 半个工具调用, 恢复后模型
 * 看到的是一份自相矛盾的历史。
 */
export interface PauseGate {
  isPaused(): boolean;
  waitForResume(ctx: { sessionId: string; iteration: number; toolCalls: number }): Promise<void>;
  /** Cancel the pause and wake waiters when the run stops. */
  cancel?(): void;
}

/**
 * Wait for resume while also observing an optional abort signal.
 *
 * An abort cancels the gate so a later iteration does not inherit the pause.
 */
export async function waitForResumeOrAbort(
  gate: PauseGate,
  ctx: { sessionId: string; iteration: number; toolCalls: number },
  signal?: AbortSignal,
): Promise<'resumed' | 'aborted'> {
  if (signal?.aborted) {
    gate.cancel?.();
    return 'aborted';
  }
  if (!signal) {
    await gate.waitForResume(ctx);
    return 'resumed';
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([gate.waitForResume(ctx).then(() => 'resumed' as const), aborted]);
    if (outcome === 'aborted') gate.cancel?.();
    return outcome;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
