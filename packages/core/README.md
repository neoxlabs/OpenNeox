# @openneox/core

**OpenNeox Agent Core** · shared runtime engine powering
[`@openneox/cli`](https://www.npmjs.com/package/@openneox/cli) and
[`@openneox/sdk`](https://www.npmjs.com/package/@openneox/sdk).

## What's inside

- `RuntimeOrchestrator` · multi-step agent loop with tool calling
- Sub-agent scheduling + cross-process checkpoint
- Battery-included tools (fs / shell / web / git / MCP bridge)
- Platform service abstraction (Node + Electron)
- Headless agent server (Hono-based)
- Multi-provider LLM client (Anthropic / OpenAI / DeepSeek / Kimi / GLM / Gemini / Doubao / OpenAI-compat)
- Short-term memory + project memory V2 + background agent manager

## Install

Usually you don't install `@openneox/core` directly. It ships as a peer
dependency of:

- `@openneox/cli` — end-user CLI
- `@openneox/sdk` — developer SDK

If you genuinely need to talk to the low-level runtime:

```bash
npm install @openneox/core
```

## Distribution

The package builds JavaScript and declaration output for workspace hosts. It
works on Node 20+ and Electron-compatible runtimes, and has no runtime
dependency on `ts-node` or `tsx`.

## License

OpenNeox project code is licensed under the Apache License, Version 2.0. See
the repository root `LICENSE` and `NOTICE` files.
