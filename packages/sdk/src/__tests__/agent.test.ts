import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Agent } from '../agent.js';

const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
] as const;

describe('Agent', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('constructs with valid config', () => {
    const a = new Agent({ model: 'claude-sonnet-4-6' });
    expect(a.config.model).toBe('claude-sonnet-4-6');
  });

  it('throws when model missing', () => {
    // @ts-expect-error - missing required field
    expect(() => new Agent({})).toThrow(/model is required/);
  });

  it('run refuses to start without provider', async () => {
    const a = new Agent({ model: 'x' });
    await expect(a.run('hi')).rejects.toThrow(/no provider configured/i);
  });

  it('stream refuses to start without provider', async () => {
    const a = new Agent({ model: 'x' });
    const iter = a.stream('hi');
    await expect(iter.next()).rejects.toThrow(/no provider configured/i);
  });

  it('abort is a no-op without crashing', () => {
    const a = new Agent({ model: 'x' });
    expect(() => a.abort()).not.toThrow();
  });
});
