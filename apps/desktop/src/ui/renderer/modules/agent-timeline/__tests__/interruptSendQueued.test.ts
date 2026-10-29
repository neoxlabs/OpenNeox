import { describe, expect, it, vi } from 'vitest';

type Deps = {
  dequeueLastQueued: () => Promise<string | null>;
  stopCurrent: () => Promise<void>;
  sendPrompt: (t: string) => void;
  restore: (why: string) => void;
};

async function interruptSendQueued(text: string, d: Deps): Promise<void> {
  let removed: string | null = null;
  let dequeueFailed = false;
  try { removed = await d.dequeueLastQueued(); } catch { dequeueFailed = true; }
  if (dequeueFailed) { d.restore('摘队列失败'); return; }
  if (removed == null) { d.restore('引擎队列已空'); return; }
  try { await d.stopCurrent(); } catch { d.restore('中断当前轮失败'); return; }
  d.sendPrompt(text);
}

function mk(over: Partial<Deps> = {}): Deps & { restore: ReturnType<typeof vi.fn>; sendPrompt: ReturnType<typeof vi.fn> } {
  return {
    dequeueLastQueued: async () => 'queued text',
    stopCurrent: async () => {},
    sendPrompt: vi.fn(),
    restore: vi.fn(),
    ...over,
  } as any;
}

describe('立即发送: 没发出去就必须还回输入框', () => {
  it('正常路径: 摘到了 + 停得下来 → 发送, 不还回', async () => {
    const d = mk();
    await interruptSendQueued('hi', d);
    expect(d.sendPrompt).toHaveBeenCalledWith('hi');
    expect(d.restore).not.toHaveBeenCalled();
  });

  it('引擎队列已空 → 不发送, 但必须还回 (原来这里直接 return, 消息就没了)', async () => {
    const d = mk({ dequeueLastQueued: async () => null });
    await interruptSendQueued('hi', d);
    expect(d.sendPrompt).not.toHaveBeenCalled();
    expect(d.restore).toHaveBeenCalledTimes(1);
  });

  it('摘队列抛错 → 不发送, 必须还回 (原来 catch 完 ignore, 跟"队列空"混成一条路)', async () => {
    const d = mk({ dequeueLastQueued: async () => { throw new Error('ipc down'); } });
    await interruptSendQueued('hi', d);
    expect(d.sendPrompt).not.toHaveBeenCalled();
    expect(d.restore).toHaveBeenCalledTimes(1);
  });

  it('中断失败 → 不硬发 (会跟在跑的那轮串流), 但必须还回', async () => {
    const d = mk({ stopCurrent: async () => { throw new Error('stop failed'); } });
    await interruptSendQueued('hi', d);
    expect(d.sendPrompt).not.toHaveBeenCalled();
    expect(d.restore).toHaveBeenCalledTimes(1);
  });
});
