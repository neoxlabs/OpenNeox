import { describe, it, expect } from 'vitest';
import { createSession, Session } from '../session.js';

describe('createSession()', () => {
  it('generates unique session ids', async () => {
    const a = await createSession({ model: 'test-model' });
    const b = await createSession({ model: 'test-model' });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^neox-/);
  });

  it('respects explicit sessionId', async () => {
    const s = await createSession({ model: 'test-model', sessionId: 'my-id' });
    expect(s.id).toBe('my-id');
  });

  it('fork produces a new id but inherits config', async () => {
    const s = await createSession({ model: 'test-model', sessionId: 'orig' });
    const f = s.fork();
    expect(f.id).not.toBe('orig');
    expect(f.config.model).toBe('test-model');
  });

  it('history returns empty array for new session', async () => {
    const s = await createSession({ model: 'test-model' });
    expect(s.history()).toEqual([]);
  });

  it('send 走真实执行路径 —— 缺 provider 时报 provider 而不是未实现', async () => {
    const s = await createSession({ model: 'test-model' });
    await expect(s.send('hi')).rejects.toThrow(/no provider configured/i);
  });

  it('stream 走真实执行路径, 且仍兼容 .next() 消费', async () => {
    const s = await createSession({ model: 'test-model' });
    const iter = s.stream('hi');
    await expect(iter.next()).rejects.toThrow(/no provider configured/i);
  });

  it('Session.resume 找不到会话时报 not found', async () => {
    await expect(
      Session.resume('some-id', { checkpointDir: '/tmp/neox-sdk-nonexistent-dir' }),
    ).rejects.toThrow(/not found/i);
  });
});
