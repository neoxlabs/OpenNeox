# order service

`main.mjs` → `server.mjs` 里的 `chain` 依次调用中间件，最后进 handler；错误统一交给 `errors.mjs`。
