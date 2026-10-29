# retry-fixture

一个小的任务队列示例：`src/queue.mjs` 负责顺序执行任务，`src/retry.mjs` 负责失败重试。

退避参数与上限都在 `src/retry.mjs` 里，按代码为准。
