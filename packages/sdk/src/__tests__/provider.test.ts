import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provider, providerFromEnv } from '../provider.js';

describe('provider()', () => {
  it('returns a plain ProviderConfig object', () => {
    const cfg = provider({ type: 'anthropic', apiKey: 'sk-x' });
    expect(cfg.type).toBe('anthropic');
    expect(cfg.apiKey).toBe('sk-x');
  });

  it('preserves optional fields', () => {
    const cfg = provider({
      type: 'openai',
      apiKey: 'k',
      baseURL: 'https://api.example.com',
      timeout: 30000,
      proxy: 'http://localhost:8080',
    });
    expect(cfg.baseURL).toBe('https://api.example.com');
    expect(cfg.timeout).toBe(30000);
    expect(cfg.proxy).toBe('http://localhost:8080');
  });
});

describe('providerFromEnv()', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns anthropic when ANTHROPIC_API_KEY set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
    const cfg = providerFromEnv();
    expect(cfg?.type).toBe('anthropic');
    expect(cfg?.apiKey).toBe('sk-ant-x');
  });

  it('anthropic takes precedence over openai', () => {
    process.env.ANTHROPIC_API_KEY = 'a';
    process.env.OPENAI_API_KEY = 'b';
    expect(providerFromEnv()?.type).toBe('anthropic');
  });

  it('falls back to openai when only OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-o';
    expect(providerFromEnv()?.type).toBe('openai');
  });

  it('deepseek detected + correct baseURL', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds';
    const cfg = providerFromEnv();
    expect(cfg?.type).toBe('openai-compatible');
    expect(cfg?.baseURL).toBe('https://api.deepseek.com/v1');
  });

  it('returns null when no known env var set', () => {
    expect(providerFromEnv()).toBeNull();
  });
});
