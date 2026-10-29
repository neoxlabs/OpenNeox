/**
 * work:H-16 — 第一段文本先于第一个工具调用。
 *
 * 现状: 这条是提示词引导 (不是硬闸, 见 00-总控裁决「只在出事代价不可逆的地方设硬闸」),
 * 规则落在 length-budget 的「边做边说」小节, code / work / pilot 都注入。
 * 这里钉三件事:
 *   1. 中英两版都明确要求"先出这句话, 再发工具调用";
 *   2. 该 section 在 code / work 模式的 layered prompt 里真的被注入;
 *   3. 没有哪份 mode prompt 教模型"一上来直接调工具"而盖掉它。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { buildLengthBudget } from '../layers/length-budget.js';
import { buildWorkModePrompt } from '../layers/work-mode.js';
import { buildGeneralAssistantPrompt } from '../layers/general-assistant.js';
import { initSectionsOnce } from '../sections.js';
import { buildPrompt, listSections } from '../sectionRegistry.js';

describe('H-16 第一段文本先于第一个工具调用', () => {
  it('中文: 先出句子, 再发工具调用', () => {
    const zh = buildLengthBudget('zh');
    expect(zh).toContain('第一次调用工具前');
    expect(zh).toContain('然后才发工具调用');
    expect(zh).toContain('第一条消息不要只有工具调用');
  });

  it('英文: send that sentence first, then the tool call', () => {
    const en = buildLengthBudget('en');
    expect(en).toContain('Before your first tool call');
    expect(en).toContain('send that sentence first, then the tool call');
    expect(en).toContain('never open with a bare tool call');
  });

  it('mode prompt 不与该规则冲突', () => {
    for (const prompt of [buildGeneralAssistantPrompt('zh'), buildWorkModePrompt('zh')]) {
      expect(prompt).not.toMatch(/直接调用工具.*不要说话/);
      expect(prompt).not.toMatch(/第一条消息.*只(发|调用)工具/);
    }
  });

  describe('注入范围', () => {
    beforeAll(() => initSectionsOnce());

    it.each([['code'], ['work'], ['pilot']] as const)('%s 模式的 layered prompt 里包含该规则', (agentMode) => {
      const input = {
        workDir: process.cwd(),
        language: 'zh' as const,
        promptStyle: 'layered',
        agentMode,
        skipEnvironment: true,
        precedingTextForLegacyCheck: '',
      };
      const built = buildPrompt(input);
      expect(built.full).toContain('第一次调用工具前');
      expect(built.full).toContain('然后才发工具调用');
    });

    it('length-budget 是 stable 层 section (不每轮重建)', () => {
      const section = listSections().find(s => s.name === 'length-budget');
      expect(section).toBeDefined();
      expect(section!.layer).toBe('stable');
    });
  });
});
