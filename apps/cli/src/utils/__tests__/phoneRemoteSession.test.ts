/**
 * /rc 会话侧接线: 手机答 ask_user 要交回 CLI, 手机发来的话要标成 phone 来源。
 * 用假的发行版 (registerCliEdition) 顶掉真中转 —— 不连任何网络。
 */
import { describe, expect, it } from 'vitest';
import { OPEN_EDITION, registerCliEdition, type CliPhoneRemote, type CliPhoneRemoteHost } from '../../edition/index.js';
import { PhoneRemoteSession } from '../phoneRemoteSession.js';

function fakeEdition() {
  let host: CliPhoneRemoteHost | null = null;
  let on = false;
  const turns: Array<{ text: string; source: string }> = [];
  const remote: CliPhoneRemote = {
    start: async (h) => { host = h; on = true; return { ok: true, message: 'ok' }; },
    stop: () => { on = false; },
    isOn: () => on,
    onRuntimeEvent: () => {},
    turnStart: (text, source) => { turns.push({ text, source }); },
    turnEnd: () => {},
    askUserAnswered: () => {},
  };
  registerCliEdition({ ...OPEN_EDITION, id: 'test', phoneRemote: () => remote });
  return { getHost: () => host, turns };
}

describe('PhoneRemoteSession', () => {
  const { getHost, turns } = fakeEdition();
  const replied: Array<{ id: string; answers: Record<string, string> }> = [];
  const sent: string[] = [];
  const session = new PhoneRemoteSession({
    getSessionId: () => 'session_test',
    getWorkDir: () => '/tmp/proj',
    getModel: () => 'deepseek-v4.1-flash-1017',
    sendUserMessage: (text) => sent.push(text),
    replyAskUser: (requestId, answers) => {
      replied.push({ id: requestId, answers });
      return true;
    },
    askUserAnsweredLocally: () => {},
    stop: () => {},
    info: () => {},
    warn: () => {},
  });

  it('手机发的消息当终端输入, 并标记来源是手机', async () => {
    await session.toggle();
    const host = getHost();
    expect(host).toBeTruthy();
    host!.sendUserMessage('手机上来的一句');
    expect(sent).toEqual(['手机上来的一句']);
    await session.runTurn('手机上来的一句', async () => 'ok');
    expect(turns.at(-1)).toEqual({ text: '手机上来的一句', source: 'phone' });
  });

  it('手机回答 ask_user 交回 CLI (REMOTE-01)', () => {
    const host = getHost();
    expect(host).toBeTruthy();
    host!.replyAskUser('req-1', { '要不要保留兼容': '保留' });
    expect(replied).toEqual([{ id: 'req-1', answers: { '要不要保留兼容': '保留' } }]);
  });
});
