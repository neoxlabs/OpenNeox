# @openneox/sdk

**Neox Agent SDK** · Build production-grade AI agents in 3 lines.
Multi-provider · streaming · tool calling · sub-agents · multi-turn sessions.

## Install

```bash
npm install @openneox/sdk zod
# or with your provider API key exported in env:
#   ANTHROPIC_API_KEY=sk-...  (or OPENAI_API_KEY / DEEPSEEK_API_KEY / KIMI_API_KEY)
```

## 3-line Hello World

```typescript
import { Agent } from '@openneox/sdk';

const agent = new Agent({ model: 'claude-sonnet-4-6' });
console.log((await agent.run('What is 2 + 2?')).text);
```

## Permissions

Tools run under `permission: 'auto'` by default: normal tools execute, tools marked
`dangerous: true` are denied. Two other modes:

```typescript
new Agent({ model, tools, permission: 'readonly' });          // only readOnly tools run
new Agent({ model, tools, permission: async (req) => ({       // your own approval
  approved: await askUser(req.tool, req.input),
}) });
```

`permission: 'ask'` without a handler throws at run time — by design, so a missing
approval path fails loudly instead of silently denying every tool call.

## Built-in tools

```typescript
import { builtinTools } from '@openneox/sdk/tools';

const agent = new Agent({
  model: 'claude-sonnet-4-6',
  tools: [
    ...builtinTools.fs({ root: './src', allowWrite: true }),   // read/list/search/write/edit
    ...builtinTools.shell({ allowedCommands: ['npm', 'git'] }), // execFile, no shell interpolation
  ],
});
```

`fs` pins every path inside `root` (symlink escapes included) and is read-only unless
you pass `allowWrite`. `shell` denies everything unless a command is allow-listed.

## With Tools

```typescript
import { Agent, tool } from '@openneox/sdk';
import { z } from 'zod';

const weather = tool({
  name: 'get_weather',
  description: 'Get weather for a city',
  schema: z.object({ city: z.string() }),
  handler: async ({ city }) => ({ temp: 22, city }),
});

const agent = new Agent({
  model: 'claude-sonnet-4-6',
  tools: [weather],
});

for await (const event of agent.stream('Weather in Tokyo?')) {
  switch (event.type) {
    case 'text_delta':  process.stdout.write(event.delta); break;
    case 'tool_call':   console.log('→', event.tool, event.input); break;
    case 'tool_result': console.log('✓', event.tool); break;
  }
}
```

## Offline testing with `mockLlm()`

```typescript
import { Agent } from '@openneox/sdk';
import { mockLlm } from '@openneox/sdk/testing';

const agent = new Agent({
  model: 'mock',
  provider: mockLlm({
    responses: [
      { type: 'tool_call', tool: 'get_weather', input: { city: 'Tokyo' } },
      { type: 'text', content: "It's 22°C in Tokyo." },
    ],
  }),
});

const result = await agent.run('weather?');
// no network, no API key, just scripted event replay
```

## Feature Set

| Feature | Status |
|---|:---:|
| `Agent.run()` / `Agent.stream()` with tool calling | ✅ |
| `tool()` helper (Zod schema · JSONSchema emitted automatically) | ✅ |
| Multi-provider (Anthropic / OpenAI / DeepSeek / Kimi / GLM / Gemini / Doubao / OpenAI-compat) | ✅ |
| `AbortSignal` cancellation | ✅ |
| `mockLlm()` / `replay()` testing helpers | ✅ |
| `permission` modes (`auto` / `readonly` / custom handler) | ✅ |
| Built-in tools: `builtinTools.fs()` / `builtinTools.shell()` | ✅ |
| Session · multi-turn with checkpoint dir + `Session.resume()` | ✅ |
| Sub-agents via `builtinTools.agent()` | ✅ |
| `builtinTools.web()` (fetch / search) | ❌ not implemented |
| MCP tool bridge | ❌ lives in the Neox product runtime, not the SDK |

## How it works

Under the hood `Agent.run()` drives the Neox kernel's `StreamedRunner` in-process and
translates its events into the SDK's public `AgentEvent` shape. You get a clean agent
loop — no taskagent / project-memory / background machinery from the Neox product.

Full documentation is available in this repository's `docs/` directory.

## Peer dependency

This SDK uses `@openneox/core` from the workspace and shares its Apache-2.0
runtime contracts.

## License

Apache-2.0. See the repository root `LICENSE` and `NOTICE` files.
