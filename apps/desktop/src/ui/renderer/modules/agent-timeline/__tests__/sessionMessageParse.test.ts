import { describe, it, expect } from 'vitest';
import { detectSystemMessages, isBusEventMessage } from '../cells/systemMessageParsers';
import { buildSessionPeerContent } from '../sessionPeerStep';

/* 跟 core runtime/peers/sessionPeers.ts buildSessionMessageXml 产出的格式一致 */
const xml = [
  '<session-message>',
  '<from>API 重构</from>',
  '<from-session>sess-123</from-session>',
  '<from-cwd>/Users/me/work/api</from-cwd>',
  '<from-client>cli</from-client>',
  '<body>接口改好了 &lt;v2&gt;, 你那边可以联调了</body>',
  '<note>This message comes from another Neox agent session…</note>',
  '</session-message>',
].join('\n');

describe('<session-message> 收件卡', () => {
  it('算总线事件, 不算用户说的话', () => {
    expect(isBusEventMessage(xml)).toBe(true);
  });

  it('解析出发件会话和正文 (正文反转义)', () => {
    const hits = detectSystemMessages(xml);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      kind: 'session_message',
      data: {
        fromName: 'API 重构',
        fromSessionId: 'sess-123',
        fromCwd: '/Users/me/work/api',
        fromClient: 'cli',
        body: '接口改好了 <v2>, 你那边可以联调了',
      },
    });
  });

  it('跟别的总线事件拼在同一条里也都认得出', () => {
    const hits = detectSystemMessages(`${xml}\n<scheduled-wakeup><reason>r</reason></scheduled-wakeup>`);
    expect(hits.map(h => h.kind)).toEqual(['session_message', 'scheduled_wakeup']);
  });
});

describe('send_to_session 发件行', () => {
  it('发出去: 对方名字 + 正文开头', () => {
    const c = buildSessionPeerContent({
      type: 'tool_call', toolName: 'send_to_session',
      toolArgs: { to: 'sess-9', message: '帮我看下 web 端的登录页' },
      output: JSON.stringify({ status: 'sent', to: '前端', session_id: 'sess-9' }),
    } as any) as any;
    expect(c).toMatchObject({ type: 'op_chip', label: '发消息给「前端」', hint: '帮我看下 web 端的登录页', tone: 'primary' });
  });

  it('没送到: 行上写原因', () => {
    const c = buildSessionPeerContent({
      type: 'tool_call', toolName: 'send_to_session',
      toolArgs: { to: 'x', message: 'hi' },
      output: JSON.stringify({ status: 'error', error: 'that session has closed' }),
    } as any) as any;
    expect(c).toMatchObject({ tone: 'err', hint: 'that session has closed' });
  });

  it('别的工具不管', () => {
    expect(buildSessionPeerContent({ type: 'tool_call', toolName: 'bash' } as any)).toBeUndefined();
  });
});
