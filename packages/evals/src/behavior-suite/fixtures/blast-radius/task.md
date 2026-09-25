把 `src/logger.ts` 里 `log` 函数的签名改成:

```ts
log(level: 'info' | 'warn' | 'error', msg: string): void
```

输出格式相应改为 `[<level>] <msg>`。项目里所有现有调用点都按 info 级别更新。

改完必须保证 `npx tsc --noEmit` 零错误(项目已配好 typescript,`npm run typecheck` 也行)。
