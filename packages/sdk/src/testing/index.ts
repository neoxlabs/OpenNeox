/**
 * @openneox/sdk/testing · 测试辅助 (浏览器+Node 通用)
 *
 *   - mockLlm(): 返回 MockProvider,按 responses 顺序发出事件,unit test 用
 *   - isMockProvider() / generateMockEvents(): SDK 内部识别 mock 跑脚本回放
 *
 *   replay(fixturePath) 从 JSONL 文件读取 — node-only, 已移到 @openneox/sdk/testing/node,
 *   主入口不再含 fs 依赖, 这样浏览器侧 import '@openneox/sdk/testing' 不会爆 fs.
 *
 * v0.3.0 起 Agent.run()/stream() 自动识别 mockLlm provider, 直接走脚本回放路径,
 * 不触发 core runtime / 不发网络.
 */

import type { ProviderConfig } from '../provider.js';
import type { AgentEvent } from '../types.js';

export type MockLlmResponseEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; tool: string; input: unknown; id?: string }
  | { type: 'tool_result_ack' }
  | { type: 'thinking'; content: string }
  | { type: 'error'; error: string };

export interface MockLlmOptions {
  /** 按顺序返回的事件/响应 · Agent 消费时按此脚本产出 AgentEvent */
  responses: MockLlmResponseEvent[];
  /** 每个 response 之间的延迟(ms),模拟真 stream 节奏,默认 0 */
  delayMs?: number;
}

/**
 * MockProvider · 内部标记,Agent 可识别并 bypass 真正 LLM 调用.
 * 导出为 ProviderConfig & { __mock: ... } 的扩展形态.
 */
export interface MockProvider extends ProviderConfig {
  __mock: MockLlmOptions;
}

/**
 * 构造一个 mock provider. Agent/Session 检测到 __mock 字段就走脚本回放路径,
 * 不调用任何真 LLM/network.
 *
 * @example
 *   const agent = new Agent({
 *     model: 'mock',
 *     provider: mockLlm({
 *       responses: [
 *         { type: 'text', content: 'Hello!' },
 *         { type: 'tool_call', tool: 'get_weather', input: { city: 'Tokyo' } },
 *],
 *     }),
 *   });
 */
export function mockLlm(options: MockLlmOptions): MockProvider {
  return {
    type: 'openai-compatible',
    apiKey: '__mock__',
    baseURL: 'http://mock.local',
    __mock: { ...options, responses: [...options.responses] },
  };
}

/**
 * 从 JSONL 字符串构造一个 replay provider (浏览器+Node 通用).
 * fixture 每行一个 JSON AgentEvent, agent 按行顺序发出.
 *
 * 不接受文件路径 — 浏览器没 fs. 文件读取走 node 入口的 replayFromFile(), 见 testing/node.ts.
 *
 * @example
 *   provider: replayFromJsonl(fs.readFileSync('./run.jsonl', 'utf-8'))
 */
export function replayFromJsonl(jsonl: string, sourceLabel = 'inline'): MockProvider {
  const lines = jsonl
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('#'));

  const responses: MockLlmResponseEvent[] = lines.map((line, i) => {
    try {
      const obj = JSON.parse(line);
      if (!obj.type) {
        throw new Error(`line ${i + 1}: missing "type" field`);
      }
      return obj as MockLlmResponseEvent;
    } catch (e) {
      throw new Error(
        `replayFromJsonl(): failed to parse ${sourceLabel} line ${i + 1}: ${(e as Error).message}`,
      );
    }
  });

  return mockLlm({ responses });
}

/** 检查给定 provider 是否为 mock(Agent 内部用). */
export function isMockProvider(provider: ProviderConfig | undefined): provider is MockProvider {
  return !!provider && typeof provider === 'object' && '__mock' in provider;
}

/**
 * 生成 AgentEvent 流生成器,从 MockProvider 的 responses 逐条产出.
 * 返回 AsyncIterable 可 await-for. 每 response 之间插入 delayMs 延迟.
 */
export async function* generateMockEvents(
  provider: MockProvider,
): AsyncIterable<AgentEvent> {
  const { responses, delayMs = 0 } = provider.__mock;
  let stepIndex = 0;
  let idCounter = 0;

  yield { type: 'step_start', step: stepIndex };

  for (const r of responses) {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    switch (r.type) {
      case 'text':
        yield { type: 'text_delta', delta: r.content };
        break;
      case 'tool_call':
        yield {
          type: 'tool_call',
          tool: r.tool,
          input: r.input,
          id: r.id ?? `mock-${++idCounter}`,
        };
        break;
      case 'tool_result_ack':
        // ack 是一个内部信号,Agent 看到后继续下一步
        break;
      case 'thinking':
        yield { type: 'thinking', delta: r.content };
        break;
      case 'error':
        yield { type: 'error', error: new Error(r.error) };
        return;
    }
  }

  yield { type: 'step_end', step: stepIndex };
  yield {
    type: 'done',
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'end_turn',
  };
}
