import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AskUserView } from '../modules/agent-timeline/cells/AskUserView';

const variant = vi.hoisted(() => ({ isCode: false }));
vi.mock('../hooks/useAgentModeVariant', () => ({
  useAgentModeVariant: () => ({ isCode: variant.isCode }),
}));

const Q1 = 'ordersys 目录在哪里？方便的话给我完整路径';
const Q2 = '要不要顺便清掉临时文件？';
const A1 = '它在 D 盘或某个项目目录，我告诉你路径';

function render(props: Record<string, unknown>) {
  return renderToStaticMarkup(React.createElement(AskUserView, props as never));
}

/** 只取用户**看得见**的文字 —— 去掉标签也就去掉了 title 这类悬浮才可见的属性。 */
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ');

/** 一段文字在可见文本里出现几次 */
function occurrences(html: string, needle: string): number {
  const text = visible(html);
  let n = 0; let i = text.indexOf(needle);
  while (i !== -1) { n++; i = text.indexOf(needle, i + needle.length); }
  return n;
}

describe('已收尾的问答卡', () => {
  it('自检: 收尾态确实渲染出了内容', () => {
    /* 对照组 —— 组件早退成 null 时先红, 免得下面在空串上平凡通过 */
    const html = render({ status: 'answered', questions: [{ question: Q1, options: [], answer: A1 }] });
    expect(html.length).toBeGreaterThan(20);
    expect(visible(html)).toContain('已回答');
  });

  it('单问题: 问题原文一次都不重复 —— 它在折叠头里', () => {
    const html = render({ status: 'answered', questions: [{ question: Q1, options: [], answer: A1 }] });
    expect(occurrences(html, Q1)).toBe(0);
    /* 而答案必须还在 —— 省掉问题不是把这一行删空 */
    expect(occurrences(html, A1)).toBe(1);
  });

  it('单问题的答案占满整行, 不再挤在 40% 窄槽里', () => {
    const html = render({ status: 'answered', questions: [{ question: Q1, options: [], answer: A1 }] });
    expect(html).toContain('atl-ask__settled-a is-sole');
  });

  it('多问题: 问题原文必须留着 —— 折叠头只放得下第一个', () => {
    const html = render({
      status: 'answered',
      questions: [
        { question: Q1, options: [], answer: A1 },
        { question: Q2, options: [], answer: '不用' },
      ],
    });
    expect(occurrences(html, Q1)).toBe(1);
    expect(occurrences(html, Q2)).toBe(1);
  });

  it('超时/中断且没答案时, 问题补回来 —— 否则这行只剩一个状态标', () => {
    const html = render({ status: 'timeout', questions: [{ question: Q1, options: [] }] });
    expect(visible(html)).toContain('已超时');
    expect(occurrences(html, Q1)).toBe(1);
  });

  it('waiting 态不受影响 —— 那张卡要保持完整交互', () => {
    const html = render({ status: 'waiting', questions: [{ question: Q1, options: [{ label: 'D 盘' }] }] });
    expect(visible(html)).toContain(Q1);
    expect(visible(html)).not.toContain('已回答');
  });
});

describe('已收尾的问答卡 (Code 工具行, 2026-10-15 定版)', () => {
  afterEach(() => { variant.isCode = false; });

  it('一问一答: 问题、答案各出现一次, 不再额外标「已回答」', () => {
    variant.isCode = true;
    const html = render({ status: 'answered', questions: [{ question: Q1, options: [], answer: A1 }] });
    expect(occurrences(html, Q1)).toBe(1);
    expect(occurrences(html, A1)).toBe(1);
    expect(visible(html)).not.toContain('已回答');
  });

  it('没答案时保留状态标, 问题原文也在', () => {
    variant.isCode = true;
    const html = render({ status: 'timeout', questions: [{ question: Q1, options: [] }] });
    expect(visible(html)).toContain('已超时');
    expect(occurrences(html, Q1)).toBe(1);
  });
});
