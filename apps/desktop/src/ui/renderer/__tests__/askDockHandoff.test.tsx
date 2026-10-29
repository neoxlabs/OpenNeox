import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AskUserView } from '../modules/agent-timeline/cells/AskUserView';
import { setAskDockShown } from '../modules/agent-timeline/askDockPresence';

vi.mock('../hooks/useAgentModeVariant', () => ({
  useAgentModeVariant: () => ({ isCode: false }),
}));

const RID = 'req-1';
const Q = '先做 A 还是先做 B?';
const OPTS = [{ label: '先做 A' }, { label: '先做 B' }];

function render(props: Record<string, unknown>) {
  return renderToStaticMarkup(React.createElement(AskUserView, props as never));
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const waitingProps = {
  requestId: RID,
  status: 'waiting',
  questions: [{ question: Q, options: OPTS }],
};

afterEach(() => setAskDockShown(null));

describe('ask 卡与药丸的分工', () => {
  it('药丸没接管时: 卡片是完整的, 选项点得到', () => {
    setAskDockShown(null);
    const t = text(render(waitingProps));
    expect(t, '问题原文必须在').toContain(Q);
    expect(t, '选项必须在 —— 药丸不在时这里是唯一能答的地方').toContain('先做 A');
    expect(t).toContain('先做 B');
  });

  it('药丸接管时: 收成一行, 不再重复摆一份选项', () => {
    setAskDockShown(RID);
    const t = text(render(waitingProps));
    expect(t, '让位后不该再有第二份选项').not.toContain('先做 A');
    expect(t, '让位后不该再有第二份选项').not.toContain('先做 B');
    expect(t, 'timeline 流水不能断, 仍要留一行').toContain('等你选择');
  });

  it('药丸接管的是别的 ask 时, 这张卡照常完整', () => {
    setAskDockShown('req-other');
    const t = text(render(waitingProps));
    expect(t, '接管的不是它, 不许让位').toContain('先做 A');
  });

  it('已收尾的卡不受药丸接管影响', () => {
    setAskDockShown(RID);
    const t = text(render({
      requestId: RID,
      status: 'answered',
      questions: [{ question: Q, options: OPTS, answer: '先做 A' }],
    }));
    expect(t).toContain('已回答');
    expect(t).toContain('先做 A');
  });
});
