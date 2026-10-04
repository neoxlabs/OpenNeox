/**
 * 05-provider-config.ts · LLM provider 手动 + 自动配置
 */

import { Agent, provider, providerFromEnv } from '@neoxlabs/sdk';

// 方式 1: 显式配置
const anthropic = provider({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY ?? 'sk-ant-xxx',
  baseURL: 'https://api.anthropic.com',
  timeout: 120_000,
});
console.log('Explicit provider:', anthropic.type);

// 方式 2: 环境变量自动推断(优先级 ANTHROPIC > OPENAI > DEEPSEEK > KIMI)
const auto = providerFromEnv();
console.log('Auto provider:', auto ? auto.type : '(none detected)');

// 方式 3: 兼容 OpenAI 协议的任意第三方
const deepseek = provider({
  type: 'openai-compatible',
  apiKey: process.env.DEEPSEEK_API_KEY ?? 'sk-ds-xxx',
  baseURL: 'https://api.deepseek.com/v1',
});

// 传给 Agent
const agent = new Agent({
  model: 'deepseek-chat',
  provider: deepseek,
});

console.log(`Agent ready with ${agent.config.provider?.type} provider`);
