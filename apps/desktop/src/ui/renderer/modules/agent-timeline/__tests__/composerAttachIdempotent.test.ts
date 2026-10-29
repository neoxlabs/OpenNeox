import { describe, it, expect } from 'vitest';

type Attachment = { id: string; type: string; name?: string; path?: string; data?: string };

/** 复刻 NeoxRuntimeBridge.addAttachment 的 upsert 语义 (按 id 覆盖, 否则追加) */
function upsert(prev: Attachment[], a: Attachment): Attachment[] {
  const i = prev.findIndex((x) => x.id === a.id);
  if (i >= 0) { const next = [...prev]; next[i] = a; return next; }
  return [...prev, a];
}

/** 与 TimelineComposer 的 attach-path 落地同源: id = `file:${绝对路径}` */
const attachIdFor = (p: string) => `file:${p}`;
const mk = (p: string): Attachment =>
  ({ id: attachIdFor(p), type: 'file', data: '', name: p.split('/').pop(), path: p });

const A = '/ws/calc.js';
const B = '/ws/README.md';

describe('attach-path 落地必须幂等', () => {
  it('两个 composer 实例各处理一次同一事件 → 仍只有一条 (这就是实拍那个 bug)', () => {
    let list: Attachment[] = [];
    list = upsert(list, mk(A));   /* 可见 composer */
    list = upsert(list, mk(A));   /* 隐藏 composer */
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(A);
  });

  it('用户重复点「加到输入框」也只有一条 —— 同一文件引用两次对模型没意义还翻倍上下文', () => {
    let list: Attachment[] = [];
    for (let i = 0; i < 5; i++) list = upsert(list, mk(A));
    expect(list).toHaveLength(1);
  });

  it('不同文件正常累加, 别把去重做过头', () => {
    let list: Attachment[] = [];
    list = upsert(list, mk(A));
    list = upsert(list, mk(B));
    expect(list.map((x) => x.path)).toEqual([A, B]);
  });

  it('随机 id 会退回到 bug 行为 —— 说明这条测试确实在守 id 的派生方式', () => {
    let list: Attachment[] = [];
    const rand = (p: string): Attachment => ({ ...mk(p), id: `file-${Math.random()}` });
    list = upsert(list, rand(A));
    list = upsert(list, rand(A));
    expect(list).toHaveLength(2); /* 正是修复前的现象 */
  });

  it('id 里带全路径, 同名不同目录不会互相覆盖', () => {
    let list: Attachment[] = [];
    list = upsert(list, mk('/ws/a/index.ts'));
    list = upsert(list, mk('/ws/b/index.ts'));
    expect(list).toHaveLength(2);
  });
});
