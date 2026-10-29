/** Verify that checkpoint metadata survives simple-git's subject/body split. */
import { describe, it, expect } from 'vitest';
import { ShadowGitCheckpoint } from '../ShadowGitCheckpoint.js';

/** Models simple-git's subject and body fields. */
function splitLikeSimpleGit(full: string): { message: string; body: string } {
  const lines = full.split('\n');
  return { message: lines[0] || '', body: lines.slice(1).join('\n').replace(/^\n+/, '') };
}

const inst = new ShadowGitCheckpoint() as any;
const format = (label: string, stats: any) => inst.formatCommitMessage(label, stats);
const parse = (msg: string) => inst.parseCommitMessage(msg);

const STATS = { created: 2, modified: 1, deleted: 3, directories: 0, total: 6 };

describe('checkpoint commit message 往返', () => {
  it('完整消息能解析出 session / messageIndex / stats', () => {
    inst.currentSessionId = 'session-abc-123';
    inst.currentMessageIndex = 4;
    const parsed = parse(format('Message completed', STATS));
    expect(parsed.label).toBe('Message completed');
    expect(parsed.sessionId).toBe('session-abc-123');
    expect(parsed.messageIndex).toBe(4);
    expect(parsed.stats.total).toBe(6);
  });

  it('只喂 subject (老写法) 会丢掉 session 和 stats —— 这就是原来的 bug', () => {
    inst.currentSessionId = 'session-abc-123';
    const { message } = splitLikeSimpleGit(format('Message completed', STATS));
    const parsed = parse(message);
    expect(parsed.sessionId).toBe('');
    expect(parsed.stats.total).toBe(0);
  });

  it('subject + body 拼回后与完整消息等价 (getCheckpoints 现在的做法)', () => {
    inst.currentSessionId = 'session-abc-123';
    inst.currentMessageIndex = 7;
    const { message, body } = splitLikeSimpleGit(format('User changes before message', STATS));
    const parsed = parse([message, body].filter(Boolean).join('\n'));
    expect(parsed.label).toBe('User changes before message');
    expect(parsed.sessionId).toBe('session-abc-123');
    expect(parsed.messageIndex).toBe(7);
    expect(parsed.stats).toMatchObject({ created: 2, modified: 1, deleted: 3, total: 6 });
  });

  it('body 为空 (Initial checkpoint 那种) 不炸, 退化成空 session', () => {
    const parsed = parse(['Initial checkpoint', ''].filter(Boolean).join('\n'));
    expect(parsed.label).toBe('Initial checkpoint');
    expect(parsed.sessionId).toBe('');
    expect(parsed.stats.total).toBe(0);
  });
});
