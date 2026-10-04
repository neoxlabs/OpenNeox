import { describe, it, expect } from 'vitest';
import { buildInstructions } from '../systemPrompt.js';
import { resolveBuiltinModelProfile } from '@neoxlabs/kernel';

const NOTE = '回复别用表格';

function profileWithNote(model: string, protocol: string) {
  const base = resolveBuiltinModelProfile({ model, protocol });
  return { ...base, prompt: { ...(base.prompt ?? {}), userInstructions: NOTE } };
}

describe('prompt.userInstructions', () => {
  it('layered 风格: 追加在最后, 带标题', () => {
    const prompt = buildInstructions({
      workDir: '/tmp/x', language: 'zh', model: 'deepseek-v4-flash', protocol: 'openai',
      modelProfile: profileWithNote('deepseek-v4-flash', 'openai'),
    });
    expect(prompt.trimEnd().endsWith(`## 用户对这个模型的叮嘱\n${NOTE}`)).toBe(true);
  });

  it('节约模式也带, 且内置 appendInstructions 不受影响', () => {
    const profile = profileWithNote('deepseek-v4-flash', 'openai');
    const prompt = buildInstructions({
      workDir: '/tmp/x', language: 'zh', model: 'deepseek-v4-flash', protocol: 'openai',
      modelProfile: profile, promptStyle: 'lean',
    });
    expect(prompt).toContain(NOTE);
    expect(profile.prompt?.appendInstructions ?? '').not.toContain(NOTE);
  });

  it('没写就不出现标题', () => {
    const prompt = buildInstructions({ workDir: '/tmp/x', language: 'zh', model: 'deepseek-v4-flash', protocol: 'openai' });
    expect(prompt).not.toContain('用户对这个模型的叮嘱');
  });
});
