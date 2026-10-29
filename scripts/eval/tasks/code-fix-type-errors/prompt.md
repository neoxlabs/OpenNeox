这个 TypeScript 项目在 `strict` 下类型检查不通过，而且有一处行为也不对：`displayName` 在用户没有 `name` 时应该回退成 `用户<id>`（大写）。

请修 `src/` 里的实现，使：
- `tsc --noEmit` 通过；
- `node --experimental-strip-types --test test/behavior.test.ts` 全绿。

不许改 `test/` 下的文件；不许用 `@ts-ignore` / `@ts-expect-error` / `as any` / `: any` 绕过类型检查。
