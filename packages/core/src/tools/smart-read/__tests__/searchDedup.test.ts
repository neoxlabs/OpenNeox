import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSearch,
  findFreshSearch,
  bumpWorkspaceEpoch,
  noteDuplicateHit,
  drainDuplicateCounts,
  dropSessionLedger,
} from '../readLedger.js';

// 无 chatSession 上下文时, ledger 走 '__default__' session。
const SID = '__default__';

describe('search dedup ledger', () => {
  beforeEach(() => {
    dropSessionLedger(SID);
  });

  it('记录后同 key 命中, 不同 key 不命中', () => {
    recordSearch('k1', 3, ['a.ts', 'b.ts']);
    const hit = findFreshSearch('k1');
    expect(hit?.matchCount).toBe(3);
    expect(hit?.filesWithMatches).toEqual(['a.ts', 'b.ts']);
    expect(findFreshSearch('k2')).toBeUndefined();
  });

  it('工作区写纪元 +1 → 缓存作废 (期间有写)', () => {
    recordSearch('k1', 3, ['a.ts']);
    expect(findFreshSearch('k1')).toBeDefined();
    bumpWorkspaceEpoch(); // 模拟一次 edit/write
    expect(findFreshSearch('k1')).toBeUndefined();
  });

  it('写后重新搜同 key → 又新鲜 (新纪元下重新登记)', () => {
    recordSearch('k1', 3, ['a.ts']);
    bumpWorkspaceEpoch();
    expect(findFreshSearch('k1')).toBeUndefined();
    recordSearch('k1', 5, ['a.ts', 'c.ts']); // 重搜登记新结果
    const hit = findFreshSearch('k1');
    expect(hit?.matchCount).toBe(5);
  });

  it('noteDuplicateHit("search") 累加, drain 清零', () => {
    noteDuplicateHit('search');
    noteDuplicateHit('search');
    noteDuplicateHit('read');
    const c = drainDuplicateCounts(SID);
    expect(c.search).toBe(2);
    expect(c.read).toBe(1);
    // drain 后清零
    expect(drainDuplicateCounts(SID)).toEqual({ read: 0, search: 0 });
  });

  it('dropSessionLedger 清掉搜索缓存 + 纪元', () => {
    recordSearch('k1', 1, ['a.ts']);
    bumpWorkspaceEpoch();
    dropSessionLedger(SID);
    // 清后: 纪元归 0, 缓存空 → 老 key 不在
    expect(findFreshSearch('k1')).toBeUndefined();
    recordSearch('k1', 1, ['a.ts']);
    expect(findFreshSearch('k1')).toBeDefined(); // 纪元回到 0, 新记录命中
  });

  it('每 session 上限 200, 超出淘汰最旧', () => {
    for (let i = 0; i < 205; i++) recordSearch(`q${i}`, 1, []);
    // 最旧的应被淘汰
    expect(findFreshSearch('q0')).toBeUndefined();
    expect(findFreshSearch('q204')).toBeDefined();
  });
});
