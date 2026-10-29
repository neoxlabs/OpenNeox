import { describe, it, expect, afterEach } from 'vitest';
import { stripStaleImages } from '../imageHistoryGuard.js';
import type { Message } from '../../types/index.js';

const img = (n: string): Message => ({
  role: 'user',
  content: [
    { type: 'text', text: `screenshot ${n}` },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(1000)}` } },
  ],
} as Message);

const txt = (role: Message['role'], t: string): Message => ({ role, content: t } as Message);

describe('imageHistoryGuard.stripStaleImages', () => {
  afterEach(() => { delete process.env.NEOX_KEEP_IMAGE_TURNS; });

  it('default (no env) keeps last 3 user turns, strips older images', () => {
    const msgs: Message[] = [
      img('t1'),                  // turn1 → 默认窗口外, 剥离
      txt('assistant', 'a1'),
      img('t2'),                  // turn2 → 保留
      txt('assistant', 'a2'),
      img('t3'),                  // turn3 → 保留
      txt('assistant', 'a3'),
      txt('user', 'current'),     // turn4 (最新)
    ];
    const r = stripStaleImages(msgs); // 默认 keepTurns=3
    expect(r.strippedImages).toBe(1);
    expect((r.messages[0].content as any[]).some((p) => p.type === 'image_url')).toBe(false);
    expect((r.messages[2].content as any[]).some((p) => p.type === 'image_url')).toBe(true);
    expect((r.messages[4].content as any[]).some((p) => p.type === 'image_url')).toBe(true);
  });

  it('NEOX_KEEP_IMAGE_TURNS=off disables stripping (no-op, returns same ref)', () => {
    process.env.NEOX_KEEP_IMAGE_TURNS = 'off';
    const msgs: Message[] = [
      img('old'),
      txt('assistant', 'saw old'),
      txt('user', 'current question'),
    ];
    const r = stripStaleImages(msgs);
    expect(r.strippedImages).toBe(0);
    expect(r.messages).toBe(msgs); // 原样返回
  });

  it('keeps current-turn images, strips older ones when keepTurns=1', () => {
    const msgs: Message[] = [
      img('old'),                       // 0 user + image (history)
      txt('assistant', 'saw old'),      // 1
      txt('user', 'current question'),  // 2 last user turn (no image)
    ];
    const r = stripStaleImages(msgs, { keepTurns: 1 });
    expect(r.strippedImages).toBe(1);
    expect(r.bytesFreed).toBeGreaterThan(1000);
    // old image replaced by text placeholder
    const c0 = r.messages[0].content as any[];
    expect(c0.find((p) => p.type === 'image_url')).toBeUndefined();
    expect(c0.some((p) => p.type === 'text' && p.text.includes('省略'))).toBe(true);
  });

  it('keeps image when it is in the last user turn (keepTurns=1)', () => {
    const msgs: Message[] = [
      txt('user', 'hi'),
      txt('assistant', 'hello'),
      img('current'),                   // last user turn HAS image → keep
    ];
    const r = stripStaleImages(msgs, { keepTurns: 1 });
    expect(r.strippedImages).toBe(0);
    const last = r.messages[2].content as any[];
    expect(last.some((p) => p.type === 'image_url')).toBe(true);
  });

  it('does not mutate the input messages (keepTurns=1)', () => {
    const msgs: Message[] = [img('old'), txt('user', 'now')];
    const before = JSON.stringify(msgs);
    stripStaleImages(msgs, { keepTurns: 1 });
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it('keepTurns=0 strips everything including current', () => {
    const msgs: Message[] = [img('a'), txt('assistant', 'x'), img('b')];
    const r = stripStaleImages(msgs, { keepTurns: 0 });
    expect(r.strippedImages).toBe(2);
  });

  it('keepTurns=2 keeps last two user turns', () => {
    const msgs: Message[] = [
      img('t1'),                  // 0 user+img (turn1)
      txt('assistant', 'a1'),     // 1
      img('t2'),                  // 2 user+img (turn2)
      txt('assistant', 'a2'),     // 3
      img('t3'),                  // 4 user+img (turn3, latest)
    ];
    const r = stripStaleImages(msgs, { keepTurns: 2 });
    // keep turn2 + turn3 images, strip turn1
    expect(r.strippedImages).toBe(1);
    expect((r.messages[0].content as any[]).some((p) => p.type === 'image_url')).toBe(false);
    expect((r.messages[2].content as any[]).some((p) => p.type === 'image_url')).toBe(true);
    expect((r.messages[4].content as any[]).some((p) => p.type === 'image_url')).toBe(true);
  });

  it('reads NEOX_KEEP_IMAGE_TURNS env', () => {
    process.env.NEOX_KEEP_IMAGE_TURNS = '0';
    const r = stripStaleImages([img('a'), txt('user', 'b')]);
    // keepTurns=0 → strip the history image too (and b has no image)
    expect(r.strippedImages).toBe(1);
  });

});
