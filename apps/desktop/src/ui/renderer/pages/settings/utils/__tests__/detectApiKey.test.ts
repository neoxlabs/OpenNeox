import { describe, it, expect } from 'vitest';
import { cleanPastedSecret, detectPasted, parseAuthHint } from '../detectApiKey';

describe('cleanPastedSecret', () => {
  it('整行 env / 引号 / Bearer / 换行都剥掉', () => {
    expect(cleanPastedSecret('export OPENAI_API_KEY="sk-proj-abc123"\n')).toBe('sk-proj-abc123');
    expect(cleanPastedSecret('ANTHROPIC_API_KEY=sk-ant-xyz')).toBe('sk-ant-xyz');
    expect(cleanPastedSecret('  "sk-or-v1-aaa",')).toBe('sk-or-v1-aaa');
    expect(cleanPastedSecret('Bearer gsk_123')).toBe('gsk_123');
    expect(cleanPastedSecret('"api_key": "xai-abc"')).toBe('xai-abc');
  });
});

describe('detectPasted', () => {
  const k = (s: string) => detectPasted(s);

  it('前缀唯一的厂商直接认定', () => {
    expect(k('sk-or-v1-0123456789abcdef0123')).toMatchObject({ kind: 'key', candidates: ['openrouter'], confident: true });
    expect(k('sk-ant-api03-0123456789abcdef')).toMatchObject({ candidates: ['anthropic'], confident: true });
    expect(k('AIzaSyD-0123456789abcdefghijklmno')).toMatchObject({ candidates: ['gemini'], confident: true });
    expect(k('xai-0123456789abcdefghijklmn')).toMatchObject({ candidates: ['grok'], confident: true });
    expect(k('gsk_0123456789abcdefghijklmn')).toMatchObject({ candidates: ['groq'], confident: true });
    expect(k('sk-proj-EXAMPLE-not-a-key')).toMatchObject({ candidates: ['openai'], confident: true });
    expect(k('0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp')).toMatchObject({ candidates: ['glm'], confident: true });
    expect(k('0e8a1b2c-3d4e-4f50-8a9b-0c1d2e3f4a5b')).toMatchObject({ candidates: ['doubao'], confident: true });
  });

  it('sk- + 32 hex 只给候选, 不替用户拍板', () => {
    const r = k('sk-0123456789abcdef0123456789abcdef');
    expect(r.kind).toBe('key');
    expect(r.confident).toBe(false);
    expect(r.candidates).toEqual(['deepseek', 'dashscope']);
  });

  it('URL 当接口地址, 短词当搜索', () => {
    expect(k('https://api.example.com/v1').kind).toBe('url');
    expect(k('deepseek').kind).toBe('text');
    expect(k('智谱').kind).toBe('text');
  });

  it('认不出前缀的长随机串仍算 key (无候选)', () => {
    expect(k('Zx9QwErTyUiOpAsDfGhJkLzXcVbNm123')).toMatchObject({ kind: 'key', candidates: [], confident: false });
  });
});

describe('parseAuthHint', () => {
  it('拆出申请地址和格式', () => {
    expect(parseAuthHint('https://openrouter.ai/keys · 格式 sk-or-v1-...')).toEqual({ keyUrl: 'https://openrouter.ai/keys', format: 'sk-or-v1-...' });
    expect(parseAuthHint('https://api.together.xyz/settings/api-keys')).toEqual({ keyUrl: 'https://api.together.xyz/settings/api-keys', format: undefined });
  });
});
