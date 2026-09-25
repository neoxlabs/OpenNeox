import { describe, expect, it } from 'vitest';
import type { ToolPack } from '../../../tools/packs/toolPack.js';
import {
  JevPreloadLedger,
  PRELOAD_MAX_TOOLS,
  buildPackQuestions,
  candidatePacks,
  namesForPicks,
  pickPacks,
} from '../jevToolPreload.js';

const pack = (id: string, toolNames: string[], extra: Partial<ToolPack> = {}): ToolPack => ({
  id, label: id, icon: '', description: `${id} tools`, toolNames, group: 'code' as ToolPack['group'], ...extra,
});

const browser = pack('browser', ['browser_run', 'browser_click', 'browser_get_state'], {
  unlockToolNames: ['browser_run', 'browser_get_state'],
});
const git = pack('git', ['git_status', 'git_commit']);
const files = pack('file_ops', ['readfile', 'edit']);
const secret = pack('secret', ['secret_tool'], { tier: 'hidden' });

describe('candidatePacks', () => {
  it('去掉 hidden 包和一半以上已常驻的包', () => {
    const half = pack('half', ['readfile', 'other']);
    const got = candidatePacks([browser, git, files, half, secret], new Set(['readfile', 'edit']));
    expect(got.map(p => p.id)).toEqual(['browser', 'git']);
  });
});

describe('pickPacks', () => {
  const answers = {
    'pack:browser': { type: 'noul' as const, noul: 0.93 },
    'pack:git': { type: 'noul' as const, noul: 0.79 },
    'pack:file_ops': { type: 'noul' as const, noul: 0.97 },
  };
  it('只收过门槛的, 按概率降序', () => {
    expect(pickPacks({ answers }, [browser, git, files])).toEqual([
      { packId: 'file_ops', p: 0.97 },
      { packId: 'browser', p: 0.93 },
    ]);
  });
  it('每轮个数有上限', () => {
    expect(pickPacks({ answers }, [browser, git, files], { threshold: 0.5, max: 2 })).toHaveLength(2);
  });
  it('缺答案 / 类型不对的包不选', () => {
    expect(pickPacks({ answers: { 'pack:git': { type: 'score', score: 2, confidence: 1, probabilities: {} } } }, [git])).toEqual([]);
  });
});

describe('buildPackQuestions', () => {
  it('每个包一道 noul, id 带 pack: 前缀', () => {
    const q = buildPackQuestions([browser, git]);
    expect(Object.keys(q)).toEqual(['pack:browser', 'pack:git']);
    expect(q['pack:git'].type).toBe('noul');
  });
});

describe('namesForPicks', () => {
  it('用 unlockToolNames 而不是全部 toolNames', () => {
    expect(namesForPicks([{ packId: 'browser', p: 0.9 }], [browser], [])).toEqual(['browser_run', 'browser_get_state']);
  });
  it('包声明了 preloadToolNames 就只给入口工具', () => {
    const word = pack('word', Array.from({ length: 15 }, (_, i) => `w${i}`), { preloadToolNames: ['w0', 'w1'] });
    expect(namesForPicks([{ packId: 'word', p: 0.9 }], [word], [])).toEqual(['w0', 'w1']);
  });
  it('放不下整包就跳过, 不拆包', () => {
    const big = pack('big', Array.from({ length: PRELOAD_MAX_TOOLS }, (_, i) => `t${i}`));
    expect(namesForPicks([{ packId: 'big', p: 0.95 }, { packId: 'git', p: 0.9 }], [big, git], ['already'])).toEqual(['git_status', 'git_commit']);
  });
  it('账上已有的不重复算', () => {
    expect(namesForPicks([{ packId: 'git', p: 0.9 }], [git], ['git_status'])).toEqual(['git_commit']);
  });
});

describe('JevPreloadLedger', () => {
  it('只增不减, 保持首次顺序 —— 工具前缀跨轮稳定', () => {
    const l = new JevPreloadLedger();
    expect(l.add('s', ['a', 'b'])).toEqual(['a', 'b']);
    expect(l.add('s', ['b', 'c', 'c'])).toEqual(['c']);
    expect(l.add('s', [])).toEqual([]);
    expect(l.get('s')).toEqual(['a', 'b', 'c']);
  });
  it('会话数超上限淘汰最久没用的', () => {
    const l = new JevPreloadLedger(2);
    l.add('s1', ['a']);
    l.add('s2', ['b']);
    l.get('s1');
    l.add('s3', ['c']);
    expect(l.get('s2')).toEqual([]);
    expect(l.get('s1')).toEqual(['a']);
  });
});
