import { describe, test, expect, beforeEach } from 'vitest';
import {
  swapComposerDraft, homeDraftKey, __resetComposerDraftsForTest,
} from '../composerSessionDrafts';
import { injectedImagesToAttachments, settleInjectedMessage } from '../injectOptimisticBubble';

const img = (id: string) => ({ id, type: 'image', name: `${id}.png`, data: `data:image/png;base64,${id}` }) as any;

describe('输入框按会话的草稿', () => {
  beforeEach(() => __resetComposerDraftsForTest());

  test('★ A 的图不会跟到 B; 切回 A 原样回来', () => {
    const toB = swapComposerDraft('neox:draft:A', 'neox:draft:B', { text: 'a 没发的话', attachments: [img('a1')] });
    expect(toB.attachments).toEqual([]);
    expect(toB.homeText).toBeNull();          // 有会话的文字走 localStorage, 不在这里
    const backToA = swapComposerDraft('neox:draft:B', 'neox:draft:A', { text: '', attachments: [] });
    expect(backToA.attachments.map((a) => a.id)).toEqual(['a1']);
  });

  test('★ 会话 → 新建任务 (首页): 首页是空的, 不带上一个会话的字和图', () => {
    const home = swapComposerDraft('neox:draft:A', homeDraftKey('code'), { text: 'a 的字', attachments: [img('a1')] });
    expect(home.homeText).toBe('');
    expect(home.attachments).toEqual([]);
  });

  test('首页草稿按模式分开, 切走再回来还在', () => {
    swapComposerDraft(homeDraftKey('work'), 'neox:draft:A', { text: 'work 首页写了一半', attachments: [img('w1')] });
    const code = swapComposerDraft('neox:draft:A', homeDraftKey('code'), { text: '', attachments: [] });
    expect(code.homeText).toBe('');
    const work = swapComposerDraft(homeDraftKey('code'), homeDraftKey('work'), { text: '', attachments: [] });
    expect(work.homeText).toBe('work 首页写了一半');
    expect(work.attachments.map((a) => a.id)).toEqual(['w1']);
  });

  test('★ 首页发出第一条 (会话随之建出) → 首页那份作废, 下次新建任务不会冒出刚发走的图', () => {
    swapComposerDraft(homeDraftKey('code'), 'neox:draft:NEW', { text: '', attachments: [img('sent')] }, { discardPrev: true });
    const again = swapComposerDraft('neox:draft:NEW', homeDraftKey('code'), { text: '', attachments: [] });
    expect(again.attachments).toEqual([]);
    expect(again.homeText).toBe('');
  });

  test('取出即清: 同一份草稿不会被换上两次', () => {
    swapComposerDraft('neox:draft:A', 'neox:draft:B', { text: '', attachments: [img('a1')] });
    expect(swapComposerDraft('neox:draft:B', 'neox:draft:A', { text: '', attachments: [] }).attachments).toHaveLength(1);
    expect(swapComposerDraft('neox:draft:A', 'neox:draft:A', { text: '', attachments: [] }).attachments).toHaveLength(0);
  });
});

describe('插话带图', () => {
  test('裸 base64 → dataURL, 跟正常发送的附件同形', () => {
    const out = injectedImagesToAttachments([{ mediaType: 'image/jpeg', data: 'AAAA', name: 'x.jpg' }], 1);
    expect(out).toEqual([{ id: 'injected-img-1-0', type: 'image', name: 'x.jpg', mediaType: 'image/jpeg', data: 'data:image/jpeg;base64,AAAA' }]);
  });

  test('★ 引擎接走的插话新建气泡时带图 (以前只有文字, 「退回这里」拿不回图)', () => {
    const appended: any[] = [];
    settleInjectedMessage({
      sessionId: 's', text: '看这张', timestamp: 5, isBackgroundTaskNotification: false,
      images: [{ mediaType: 'image/png', data: 'BBBB' }],
      entriesFor: () => [], update: () => undefined,
      append: (_sid, entry) => { appended.push(entry); return entry as any; },
    });
    expect(appended[0].attachments[0].data).toBe('data:image/png;base64,BBBB');
  });
});
