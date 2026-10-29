`src/validate.mjs` 里的 `validatePassword` 还没有测试。请新建 `test/validate.test.mjs`（用 `node:test` + `node:assert/strict`），把这几个分支都覆盖到：

- 传入非字符串 → `{ ok: false, reason: 'type' }`
- 长度不足 8 位（含 7 位边界）→ `reason: 'length'`
- 够长但缺大写字母 → `reason: 'upper'`
- 有大小写但缺数字 → `reason: 'digit'`
- 全部满足 → `{ ok: true }`

要求：不要修改 `src/validate.mjs`；写完跑 `node --test test/validate.test.mjs` 确认全绿。
