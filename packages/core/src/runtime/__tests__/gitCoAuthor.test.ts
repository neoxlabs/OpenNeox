import { describe, it, expect, vi, beforeEach } from 'vitest';

let enabled = true;
vi.mock('@neoxlabs/platform/runtime/agentRuntimeConfig.js', () => ({
  isGitCoAuthorEnabled: () => enabled,
}));

const { withNeoxCoAuthor, getGitCoAuthorPromptSection, NEOX_CO_AUTHOR_TRAILER } = await import('../gitCoAuthor.js');

describe('提交署名 Neox', () => {
  beforeEach(() => { enabled = true; });

  it('单行信息: 空一行再接 trailer (不空行 GitHub 不认)', () => {
    expect(withNeoxCoAuthor('fix: typo')).toBe(`fix: typo\n\n${NEOX_CO_AUTHOR_TRAILER}`);
  });

  it('已有 trailer 块: 接在块里, 不另起一段', () => {
    const msg = 'feat: x\n\nbody\n\nCo-Authored-By: Someone <a@b.c>';
    expect(withNeoxCoAuthor(msg)).toBe(`${msg}\n${NEOX_CO_AUTHOR_TRAILER}`);
  });

  it('已经带了就不重复加', () => {
    const msg = `fix: y\n\n${NEOX_CO_AUTHOR_TRAILER}`;
    expect(withNeoxCoAuthor(msg)).toBe(msg);
  });

  it('开关关着: 原样返回, prompt 段为空', () => {
    enabled = false;
    expect(withNeoxCoAuthor('fix: z')).toBe('fix: z');
    expect(getGitCoAuthorPromptSection()).toBe('');
  });

  it('开关开着: prompt 段里带完整 trailer', () => {
    expect(getGitCoAuthorPromptSection()).toContain(NEOX_CO_AUTHOR_TRAILER);
  });
});
