import { describe, expect, it } from 'vitest';
import {
  localizeBriefHint,
  recoverBriefHintParams,
  renderBriefHint,
} from '../briefHintText.js';

describe('renderBriefHint', () => {
  it('渲染两种语言的同一条规则', () => {
    const zh = renderBriefHint('overdue_reminder', { subject: '收快递' }, 'zh');
    const en = renderBriefHint('overdue_reminder', { subject: '收快递' }, 'en');
    expect(zh?.title).toBe('上次提醒的"收快递"办了吗?');
    expect(en?.title).toBe('Did you handle the "收快递" reminder?');
    /* subject 是用户自己的内容 — 不翻译, 只翻外面那层脚手架 */
    expect(en?.title).toContain('收快递');
  });

  it('引号两侧留空格 (曾被 stripHintEmoji 吃掉过)', () => {
    const en = renderBriefHint('overdue_reminder', { subject: 'pick up parcel' }, 'en');
    expect(en?.title).toBe('Did you handle the "pick up parcel" reminder?');
  });

  it('subject 里的 emoji 在插值前剥掉', () => {
    const en = renderBriefHint('overdue_reminder', { subject: '📦 收快递' }, 'en');
    expect(en?.title).toBe('Did you handle the "收快递" reminder?');
  });

  it('参数缺失返回 null, 不吐残句', () => {
    expect(renderBriefHint('overdue_reminder', {}, 'en')).toBeNull();
    expect(renderBriefHint('stale_outcome', { subject: '  ' }, 'en')).toBeNull();
    expect(renderBriefHint('evening_summary', {}, 'en')).toBeNull();
  });

  it('未知 ruleId 返回 null', () => {
    expect(renderBriefHint('nope', {}, 'en')).toBeNull();
  });

  it('evening_summary 英文单复数', () => {
    expect(renderBriefHint('evening_summary', { count: 1 }, 'en')?.title)
      .toBe('You wrapped up 1 thing today · Nice');
    expect(renderBriefHint('evening_summary', { count: 3 }, 'en')?.title)
      .toBe('You wrapped up 3 things today · Nice');
  });
});

describe('recoverBriefHintParams — 老数据反解', () => {
  it('从中文 suggestedPrompt 反解 overdue_reminder 的 subject', () => {
    expect(recoverBriefHintParams('overdue_reminder', { suggestedPrompt: '完成: 收快递' }))
      .toEqual({ subject: '收快递' });
  });

  it('从英文 suggestedPrompt 反解', () => {
    expect(recoverBriefHintParams('stale_outcome', { suggestedPrompt: 'Continue: Shanghai guide' }))
      .toEqual({ subject: 'Shanghai guide' });
  });

  it('从标题反解 evening_summary 的计数', () => {
    expect(recoverBriefHintParams('evening_summary', { title: '今天完成 4 件事 · 辛苦了' }))
      .toEqual({ count: 4 });
  });

  it('反解不出来返回 null (调用方退回库里原文)', () => {
    expect(recoverBriefHintParams('overdue_reminder', { suggestedPrompt: '乱七八糟' })).toBeNull();
  });
});

describe('localizeBriefHint', () => {
  const storedZh = {
    title: '上次提醒的"收快递"办了吗?',
    summary: '要现在办, 或者标记完成',
  };

  it('新数据: 有 i18nParams 直接按当前语言重渲', () => {
    const r = localizeBriefHint(
      { ruleId: 'overdue_reminder', i18nParams: { subject: '收快递' } },
      storedZh,
      'en',
    );
    expect(r?.title).toBe('Did you handle the "收快递" reminder?');
    expect(r?.summary).toBe('Do it now, or mark it done');
  });

  it('老数据: 无 i18nParams 时靠 suggestedPrompt 反解, 照样切得动语言', () => {
    const r = localizeBriefHint(
      { ruleId: 'overdue_reminder', suggestedPrompt: '完成: 收快递' },
      storedZh,
      'en',
    );
    expect(r?.title).toBe('Did you handle the "收快递" reminder?');
  });

  it('没有 ruleId (更老的数据) 返回 null → 展示侧用库里原文', () => {
    expect(localizeBriefHint({}, storedZh, 'en')).toBeNull();
    expect(localizeBriefHint(null, storedZh, 'en')).toBeNull();
  });
});
