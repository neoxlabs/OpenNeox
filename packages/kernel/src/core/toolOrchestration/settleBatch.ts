/**
 * 逐一结算一批异步任务 (LOOP-04 的机制层)。
 *
 * `Promise.all` 是「一个挂全批挂」: 5 个并行工具里 1 个 task reject, 另外 4 个**已经跑完**
 * 的结果也一起丢, 模型只能原样重跑。这里改用 allSettled, 每个 task 自负盈亏:
 * reject 的交给 onRejected 自己补一条失败结果, 成功的照常落地。
 *
 * 单独成文件是为了能直接单测「1 个 reject + 4 个成功」这个语义 —— 收在 batch.ts 内部
 * 时, runOne 自带 try/catch, 外部没有合法手段让它 reject, 这条路径永远测不到。
 */
export async function settleEach<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  onRejected: (item: T, reason: unknown) => void,
): Promise<void> {
  const settled = await Promise.allSettled(items.map((item) => run(item)));
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    /* 回调自己出问题只影响它自己那条 —— 别让一个写坏的 onRejected 把后面的失败也吞掉 */
    try {
      onRejected(items[index], result.reason);
    } catch { /* 交给调用方自己的日志 */ }
  });
}
