# Neox Agent SDK · Examples

| File | 范围 | v0.0.0-alpha 可跑 | v0.1.0 可跑 |
|---|---|:---:|:---:|
| `01-hello.ts` | Agent 基本构造 + tool 定义 + run 形态 | ✅ 类型/签名 | ✅ 完整 |
| `02-tools.ts` | tool() + Zod 完整能力(validate/timeout/dangerous) | ✅ 真实跑 | ✅ |
| `03-streaming.ts` | Agent.stream() 事件处理 | ✅ 类型 | ✅ 完整 |
| `04-session.ts` | createSession / fork / resume | ✅ 类型 | ✅ 完整 |
| `05-provider-config.ts` | provider() / providerFromEnv() | ✅ 真实跑 | ✅ |

运行任一 example:

```bash
npx tsx packages/sdk/examples/02-tools.ts
```

所有 example 仅依赖 `@openneox/sdk`,无副作用,可安心跑.
