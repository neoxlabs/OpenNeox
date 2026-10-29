import { describe, it, expect } from 'vitest';
import { isImageModelInfo, isChatModelInfo } from '../modelKind';

const IMAGE = [
  { id: 'gpt-image-2', name: 'GPT Image 2' },
  { id: 'gpt-image-2-4k', name: 'GPT Image 2 4K' },
  { id: 'openai/gpt-image-2-pro', name: 'GPT Image 2 Pro (23s · 横版)' },
  { id: 'dall-e-3', name: 'DALL·E 3' },
  { id: 'black-forest-labs/flux-1.1-pro', name: 'FLUX 1.1 Pro' },
  { id: 'stability/sdxl', name: 'SDXL' },
  { id: 'grok-imagine-image', name: 'Grok Imagine' },
  { id: 'google/gemini-2.5-flash-image', name: 'Gemini Flash Image' },
  { id: 'doubao-seedream-4', name: 'Seedream 4' },
  { id: 'recraft-v3', name: 'Recraft v3' },
];

const CHAT = [
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
  { id: 'grok-4.5', name: 'Grok 4.5' },
  { id: 'grok-4.3', name: 'Grok 4.3' },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'gpt-5.6', name: 'GPT-5.6' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
  /* 容易误伤的: 名字里有 vision / 4o, 但它们是对话模型 */
  { id: 'gpt-4o', name: 'GPT-4o' },
  { id: 'qwen-vl-max', name: 'Qwen VL Max' },
];

describe('模型判据', () => {
  for (const m of IMAGE) {
    it(`图像模型: ${m.name}`, () => {
      expect(isImageModelInfo(m)).toBe(true);
      expect(isChatModelInfo(m)).toBe(false);
    });
  }
  for (const m of CHAT) {
    it(`对话模型: ${m.name}`, () => {
      expect(isImageModelInfo(m)).toBe(false);
      expect(isChatModelInfo(m)).toBe(true);
    });
  }
  it('空值不炸', () => {
    expect(isImageModelInfo(null)).toBe(false);
    expect(isImageModelInfo(undefined)).toBe(false);
    expect(isChatModelInfo(null)).toBe(false);
  });
});

describe('当前套餐里的出图模型必须全部被认出来', () => {
  const IMAGE_MODELS_IN_PLAN = ['gpt-image-2', 'gpt-image-2-pro', 'grok-image', 'nano-banana-2'];
  for (const id of IMAGE_MODELS_IN_PLAN) {
    it(`${id} 判为出图模型, 不会进对话选择器`, () => {
      expect(isImageModelInfo({ id })).toBe(true);
      expect(isChatModelInfo({ id })).toBe(false);
    });
  }

  const CHAT_MODELS_IN_PLAN = [
    'deepseek-v4-flash', 'deepseek-v4-pro', 'or-free-auto', 'glm-5.2',
    'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  ];
  for (const id of CHAT_MODELS_IN_PLAN) {
    it(`${id} 不能被误判成出图模型`, () => {
      expect(isChatModelInfo({ id })).toBe(true);
    });
  }
});

describe('语音模型不进对话选择器', () => {
  for (const id of ['cosyvoice-v3-flash', 'fun-asr-realtime', 'doubao-asr', 'whisper-1', 'gpt-4o-transcribe', 'qwen-tts']) {
    it(`${id} 不是对话模型`, () => {
      expect(isChatModelInfo({ id })).toBe(false);
    });
  }
  const CURRENT_CHAT = [
    'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra',
    'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1',
    'kimi-k3', 'glm-5.3', 'qwen3.8-max', 'mimo-v2.6-pro', 'gemini-3.6-flash', 'neox-free',
  ];
  for (const id of CURRENT_CHAT) {
    it(`${id} 仍是对话模型`, () => {
      expect(isChatModelInfo({ id })).toBe(true);
    });
  }
});
