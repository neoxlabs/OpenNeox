/**
 * Verify that the dynamic model identity note does not duplicate mode-specific roles.
 *
 * The note names the selected model while personality sections own role wording.
 *
 * This test preserves that ownership boundary.
 */

import { describe, it, expect } from 'vitest';
import { getModelIdentityNote } from '../providerSupplements.js';

/* 角色类自称。注入段里出现任何一个都说明角色又被复述了。 */
const ROLE_WORDS_ZH = ['编程 Agent', '编码 Agent', '工作 Agent', '生活助理', '编程助手'];
const ROLE_WORDS_EN = ['coding Agent', 'coding agent', 'work agent', 'life assistant'];

describe('getModelIdentityNote', () => {
  it('对照组: 正常入参确实产出内容 (否则下面的断言全是空跑)', () => {
    expect(getModelIdentityNote('deepseek-v4-flash', 'zh')).toBeTruthy();
    expect(getModelIdentityNote('deepseek-v4-flash', 'en')).toBeTruthy();
  });

  it('model 为空 / auto 时不注入 —— 退回人格段的"没把握就别提型号"', () => {
    for (const v of [undefined, '', '  ', 'auto', 'AUTO']) {
      expect(getModelIdentityNote(v, 'zh')).toBeNull();
    }
  });

  it('中文注入段不复述角色', () => {
    const note = getModelIdentityNote('deepseek-v4-flash', 'zh')!;
    const hits = ROLE_WORDS_ZH.filter((w) => note.includes(w));
    expect(hits, `型号注入里又出现了角色自称: ${hits.join(' / ')}。`
      + '角色只由人格段负责 —— 这一段在 prompt 末尾, 写了会盖过按模式分发的人格段。').toEqual([]);
  });

  it('英文注入段不复述角色', () => {
    const note = getModelIdentityNote('deepseek-v4-flash', 'en')!;
    const hits = ROLE_WORDS_EN.filter((w) => note.includes(w));
    expect(hits, `role wording leaked back into the model note: ${hits.join(' / ')}`).toEqual([]);
  });

  it('仍然钉住型号 —— 防幻觉那部分不能一起删掉', () => {
    const zh = getModelIdentityNote('deepseek-v4-flash', 'zh')!;
    expect(zh).toContain('DeepSeek');            // 人类可读名
    expect(zh).toContain('deepseek-v4-flash');   // 原始 id
    expect(zh).toMatch(/不要自称其它型号或厂商/);
    const en = getModelIdentityNote('deepseek-v4-flash', 'en')!;
    expect(en).toMatch(/Do NOT claim to be any other model or vendor/);
  });
});
