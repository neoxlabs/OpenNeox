# queue

小任务队列：`cli.mjs` 读状态 → `queue.mjs` 开固定数量 worker → `runner.mjs` 跑单个任务（带重试）→ `store.mjs` 回写状态。
