import { describe, expect, it } from 'vitest';
import { createChatEventPublisher } from '../chatEventPublisher';

/** 只记"送去合成的是哪几段", 不真合成 */
function harness(opts: { isVoiceTurn?: boolean } = {}) {
  const spoken: string[] = [];
  const tts = {
    isEnabled: () => true,
    getConfig: () => ({ provider: 'edge' }),
    getStreamingMeta: () => ({ capable: false, format: 'mp3' }),
    speak: async (t: string) => { spoken.push(t); return null; },
  };
  const bus = { publish: () => undefined };
  const pub = createChatEventPublisher({ bus: bus as any, sessionId: 's1', ttsService: tts as any, isVoiceTurn: opts.isVoiceTurn });
  const say = (text: string) => { for (const ch of text.match(/.{1,3}/gs) ?? []) pub.publishRawEvent({ type: 'text', delta: ch }); };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { pub, say, spoken, flush };
}

describe('只念口播段 (chatEventPublisher)', () => {
  it('用工具的一轮: 开口两句 + 最后一段的结论; 过程话和细节都不念', async () => {
    const h = harness();
    h.say('新活收到:写摄氏转华氏。我先写脚本,再配测试跑通。顺便说一下第三句不该念。');
    h.pub.publishRawEvent({ type: 'tool_call_start', name: 'write_file' });
    h.say('脚本写好了,现在写测试。\n\n');
    h.pub.publishRawEvent({ type: 'tool_call_start', name: 'execute_shell' });
    h.say('做完了,已报给你(fyi)。\n\nshift-test6/ 下两个文件: tempconv.py 和 test_tempconv.py(19 项全过)。');
    h.pub.publishRawEvent({ type: 'run_result', output: '' });
    await h.flush();
    await h.flush();
    const all = h.spoken.join('|');
    expect(all).toContain('新活收到');
    expect(all).toContain('我先写脚本,再配测试跑通。');
    expect(all).not.toContain('第三句');
    expect(all).not.toContain('现在写测试');
    expect(all).toContain('做完了,已报给你');
    expect(all).not.toContain('tempconv.py');
  });

  it('不用工具的一轮: 就念回答的口播段', async () => {
    const h = harness();
    h.say('明天上午十点,我已经帮你记下了。\n\n- 地点: 三楼会议室\n- 带上周报');
    h.pub.publishRawEvent({ type: 'text_complete' });
    h.pub.publishRawEvent({ type: 'run_result', output: '' });
    await h.flush();
    await h.flush();
    const all = h.spoken.join('|');
    expect(all).toContain('明天上午十点');
    expect(all).not.toContain('会议室');
  });
});
