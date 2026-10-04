/**
 * @openneox/sdk · 主入口
 *
 * 3 行 hello world:
 *   ```ts
 *   import { Agent } from '@openneox/sdk';
 *   const agent = new Agent({ model: 'claude-sonnet-4-6' });
 *   console.log((await agent.run('hello')).text);
 *   ```
 *
 * 详细 API:见 NEOX_SDK_V1_API.md
 */

export { Agent, type AgentConfig, type AgentResult, type AgentStream } from './agent.js';
export {
  tool,
  type ToolConfig,
  type ToolContext,
  type NeoxSdkTool,
  type AnyNeoxSdkTool,
} from './tool.js';
export {
  createSession,
  Session,
  type CreateSessionOptions,
} from './session.js';
export {
  provider,
  providerFromEnv,
  type ProviderConfig,
  type ProviderType,
} from './provider.js';

export type {
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
  AgentEvent,
  AgentEventHandler,
  TokenUsage,
  Step,
  Message,
  Tool,
  ThinkingMode,
  PermissionMode,
  StopReason,
} from './types.js';

/** SDK 版本 · 运行时可查. */
export const VERSION = '2.7.0';
