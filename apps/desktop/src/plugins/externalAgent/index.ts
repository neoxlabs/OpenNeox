/**
 * External Agent 子系统 —— 把活派给用户机器上已装好的另一个 agent CLI
 *
 *   链路: plugin.json `externalAgents`
 *          → validate (挡带路径的 command / 解释器 / 拼接占位符)
 *          → externalAgentRegistry (materialize 成 `<id>_delegate` 工具)
 *          → runner (探测 → worktree → spawn → 流式 → 中断/超时 → 收尾)
 */

export { externalAgentRegistry } from './externalAgentRegistry.js';
export type { RegisteredExternalAgent, ExternalAgentHostHooks } from './externalAgentRegistry.js';

export { validateExternalAgents } from './validate.js';

export { delegateToExternalAgent, detectExternalAgent, buildArgs } from './runner.js';
export type { DelegateOptions, DelegateResult } from './runner.js';

export { createStreamParser } from './streamParsers.js';
export type { StreamParser, ParsedEvent } from './streamParsers.js';
