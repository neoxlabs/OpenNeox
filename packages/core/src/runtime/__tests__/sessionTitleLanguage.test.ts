import { describe, expect, it } from 'vitest';
import { titleLanguage } from '../claude/sideAgentAdapterImpl.js';

const EN_TAG = '<reply-language>Write everything the user sees this turn in English.</reply-language>';
const ZH_TAG = '<reply-language>本轮所有给用户看的话都用中文。</reply-language>';

describe('titleLanguage', () => {
  it('英文消息 + 英文 reply-language → en, 即使别处混着中文路径', () => {
    expect(titleLanguage(`Build a Q3 store review workbook\n\n${EN_TAG}\n/Users/a/Documents/Neox/工作/2026-10-16 Build`)).toBe('en');
  });

  it('中文 reply-language → zh', () => {
    expect(titleLanguage(`修复 src/app.ts 的 THIS_STRING\n\n${ZH_TAG}`)).toBe('zh');
  });

  it('没有追加段: 路径里的中文文件夹名不算用户写的中文', () => {
    expect(titleLanguage('Summarize ~/Documents/Neox/工作/report.md in three bullets')).toBe('en');
  });

  it('没有追加段: 用户写了中文就是中文 (夹英文标识符也一样)', () => {
    expect(titleLanguage('把 src/app.ts 里的 THIS_STRING 改掉')).toBe('zh');
  });
});
