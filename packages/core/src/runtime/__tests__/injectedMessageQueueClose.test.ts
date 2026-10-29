import { describe, test, expect } from 'vitest';
import { InjectedMessageQueue } from '../injectedMessageQueue.js';

describe('InjectedMessageQueue 收尾与 drain', () => {
  test('close 之后 closed=true, open 后恢复', () => {
    const q = new InjectedMessageQueue();
    expect(q.closed).toBe(false);
    q.close();
    expect(q.closed).toBe(true);
    q.open();
    expect(q.closed).toBe(false);
  });

  test('★ drain: 先 text_complete, 再逐条 user_message_injected (带图), 最后 processed', () => {
    const q = new InjectedMessageQueue();
    const images = [{ mediaType: 'image/png', data: 'AAAA' }];
    q.push({ text: '一号', timestamp: new Date(), when: 'turn-end', images });
    q.push({ text: '二号', timestamp: new Date(), when: 'turn-end' });
    const events: any[] = [];
    const drained = q.drainForContinue((e) => events.push(e));
    expect(drained.map((m) => m.text)).toEqual(['一号', '二号']);
    expect(q.length).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      'text_complete', 'user_message_injected', 'user_message_injected', 'queued_messages_processed',
    ]);
    expect(events[1].images).toEqual(images);
    expect(events[3].count).toBe(2);
  });
});
