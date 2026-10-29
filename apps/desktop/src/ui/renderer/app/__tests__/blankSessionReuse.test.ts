
import { describe, it, expect } from 'vitest';
import { isBlankSession, shouldReuseBlankSession, type BlankSessionCandidate } from '../blankSessionReuse';

const WS = '/Users/me/Code/KYDev';
const blank = (over: Partial<BlankSessionCandidate> = {}): BlankSessionCandidate =>
  ({ id: 's1', kind: 'chat', workspacePath: WS, messageCount: 0, ...over });

describe('isBlankSession', () => {
  it('messageCount=0 → 空', () => expect(isBlankSession(blank())).toBe(true));
  it('messageCount>0 → 不空', () => expect(isBlankSession(blank({ messageCount: 3 }))).toBe(false));

  it('messageCount 缺失时退回 messages 长度', () => {
    expect(isBlankSession(blank({ messageCount: null, messages: [] }))).toBe(true);
    expect(isBlankSession(blank({ messageCount: null, messages: [{}] }))).toBe(false);
  });

  it('messageCount 陈旧为 0 但 messages 非空 → 不算空 (取最大值, 不是 ??)', () => {
    expect(isBlankSession(blank({ messageCount: 0, messages: [{}, {}, {}] }))).toBe(false);
  });

  it('messageCount 陈旧为 0 但 timeline 非空 → 不算空', () => {
    expect(isBlankSession(blank({ messageCount: 0, timeline: [{}] }))).toBe(false);
  });

  it('三个信号全空才算空', () => {
    expect(isBlankSession(blank({ messageCount: 0, messages: [], timeline: [] }))).toBe(true);
  });

  it('两者都没有 → 当作空 (刚建出来的会话)', () => {
    expect(isBlankSession({ id: 's', workspacePath: WS })).toBe(true);
  });

  it('null / undefined 不抛', () => {
    expect(isBlankSession(null)).toBe(false);
    expect(isBlankSession(undefined)).toBe(false);
  });
});

describe('shouldReuseBlankSession · 该复用的场景', () => {
  it('当前就是一条没用过的会话, 再点新建 → 复用 (这就是修的那个 bug)', () => {
    expect(shouldReuseBlankSession({ active: blank(), targetWorkspace: WS })).toBe(true);
  });

  it('kind 缺省视为 chat, 两边都缺省也算同类', () => {
    expect(shouldReuseBlankSession({
      active: blank({ kind: null }), requestedKind: undefined, targetWorkspace: WS,
    })).toBe(true);
  });

  it('连点多次只会复用同一条 (判定是幂等的)', () => {
    const a = blank();
    for (let i = 0; i < 5; i++) {
      expect(shouldReuseBlankSession({ active: a, targetWorkspace: WS })).toBe(true);
    }
  });
});

describe('shouldReuseBlankSession · 权威副本 (2026-08-08 真机抓到的 regression)', () => {
  /* 一轮聊完后, bridge 内存里的 activeSession 三个信号全是陈旧的 (messageCount:0 /
   * messages:[] / timeline 不存在), 而库里已经是 messageCount:6。只看内存那份会判成空,
   * 于是用户聊完点「新建会话」→ 新话题被接着写进旧会话。 */
  it('内存副本看着是空的, 但权威副本有内容 → 必须新建', () => {
    expect(shouldReuseBlankSession({
      active: blank({ messageCount: 0, messages: [] }),
      authoritative: blank({ messageCount: 6 }),
      targetWorkspace: WS,
    })).toBe(false);
  });

  it('两份都空 → 才允许复用', () => {
    expect(shouldReuseBlankSession({
      active: blank(), authoritative: blank(), targetWorkspace: WS,
    })).toBe(true);
  });

  /* 第二版用 sessions 列表当"权威副本"仍然偶发挂 —— 那份也是内存状态, 跟 activeSession
   * 不同时机刷新, 一轮刚结束时可能两份都还是 0。现在改成决策时直接问库。 */
  it('两份内存副本都陈旧 → 仍然会误判, 所以权威副本必须来自库而不是另一份内存状态', () => {
    /* 这条是**行为说明**: 判定函数本身只认传进来的 authoritative, 传错了它也拦不住 —— 
     * 保证"传的是库里那份"是调用方的责任 (NeoxRuntimeBridge 里直接 getSessions())。 */
    expect(shouldReuseBlankSession({
      active: blank({ messageCount: 0 }),
      authoritative: blank({ messageCount: 0 }),   /* 陈旧的第二份 */
      targetWorkspace: WS,
    })).toBe(true);
  });

  it('拿不到权威副本时退回只看内存那份 (不改变原有行为)', () => {
    expect(shouldReuseBlankSession({
      active: blank(), authoritative: null, targetWorkspace: WS,
    })).toBe(true);
  });
});

describe('shouldReuseBlankSession · 必须真的新建的场景', () => {
  it('当前会话已经聊过 → 新建', () => {
    expect(shouldReuseBlankSession({ active: blank({ messageCount: 1 }), targetWorkspace: WS })).toBe(false);
  });

  it('聊过但 messageCount 陈旧为 0 → 仍要新建 (真机抓到的那条)', () => {
    expect(shouldReuseBlankSession({
      active: blank({ messageCount: 0, messages: [{}, {}, {}] }), targetWorkspace: WS,
    })).toBe(false);
  });

  it('没有活跃会话 → 新建', () => {
    expect(shouldReuseBlankSession({ active: null, targetWorkspace: WS })).toBe(false);
  });

  it('调用方指定了名字 = 想要一条特定会话 → 新建', () => {
    expect(shouldReuseBlankSession({ active: blank(), requestedName: '图片·8月7日', targetWorkspace: WS })).toBe(false);
  });

  it('kind 不同 (聊天空会话 vs 要建图片会话) → 新建', () => {
    expect(shouldReuseBlankSession({ active: blank({ kind: 'chat' }), requestedKind: 'image', targetWorkspace: WS })).toBe(false);
    expect(shouldReuseBlankSession({ active: blank({ kind: 'image' }), requestedKind: 'chat', targetWorkspace: WS })).toBe(false);
  });

  /* Life/Work 会解析到各自的 mode home, 所以"工作区不同"等价于"模式不同" */
  it('新会话会落到别的工作区 (切了项目 / 切了模式) → 新建', () => {
    expect(shouldReuseBlankSession({ active: blank(), targetWorkspace: '/Users/me/Documents/Neox/工作' })).toBe(false);
  });

  it('工作区未知时宁可多开一条, 不冒险落错地方', () => {
    expect(shouldReuseBlankSession({ active: blank(), targetWorkspace: null })).toBe(false);
    expect(shouldReuseBlankSession({ active: blank({ workspacePath: null }), targetWorkspace: WS })).toBe(false);
  });
});
