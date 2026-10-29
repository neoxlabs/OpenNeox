/**
 * @ 补全「最近文件」的跨工作区隔离 —— 见 recentFilesScope.ts 头部.
 * 漏一条不会报错, 只会在别人的项目里安静地多给几个可选文件。
 */

import { describe, expect, test } from 'vitest';
import { recentScopeOf, filterRecentByScope, type RecentFileEntry } from '../recentFilesScope';

const WS = '/private/tmp/qa-workspace';
const OTHER = '/Users/me/AI/Neox';

const E: RecentFileEntry[] = [
  { name: 'calc.js', path: `${WS}/calc.js`, ws: WS },
  { name: 'README.md', path: `${WS}/README.md`, ws: WS },
  { name: 'package.json', path: `${OTHER}/package.json`, ws: OTHER },
  /* 修复前存下的老条目: 没有 ws */
  { name: 'legacy-in.ts', path: `${WS}/src/legacy-in.ts` },
  { name: 'legacy-out.ts', path: `${OTHER}/src/legacy-out.ts` },
];

const names = (r: RecentFileEntry[]) => r.map((x) => x.name);

describe('归属域', () => {
  test('本地会话 = 工作区路径', () => {
    expect(recentScopeOf({ isCloud: false, workspacePath: WS })).toBe(WS);
  });

  test('云会话 = pod, 不用工作区 (两边路径空间不同)', () => {
    expect(recentScopeOf({ isCloud: true, sessionId: 's1', workspacePath: WS })).toBe('cloud:s1');
  });

  test('没有工作区 / 云会话缺 sessionId → 空域 (无法归属)', () => {
    expect(recentScopeOf({ isCloud: false, workspacePath: null })).toBe('');
    expect(recentScopeOf({ isCloud: true, sessionId: null, workspacePath: WS })).toBe('');
  });
});

describe('按域过滤', () => {
  test('只留本工作区的 —— 别的项目的文件必须消失', () => {
    expect(names(filterRecentByScope(E, WS))).toEqual(['calc.js', 'README.md', 'legacy-in.ts']);
  });

  test('老条目 (无 ws) 按路径前缀判: 落在域内的留, 落在域外的丢', () => {
    const out = filterRecentByScope(E, WS);
    expect(names(out)).toContain('legacy-in.ts');
    expect(names(out)).not.toContain('legacy-out.ts');
  });

  test('前缀判必须带 `/` —— 兄弟目录同前缀不算本域', () => {
    const sneaky: RecentFileEntry[] = [{ name: 'x', path: `${WS}-backup/x.ts` }];
    expect(filterRecentByScope(sneaky, WS)).toEqual([]);
  });

  test('空域 → 一条都不给 (宁可少给, 不能给错)', () => {
    expect(filterRecentByScope(E, '')).toEqual([]);
  });

  test('切到另一个工作区, 看到的是那边的', () => {
    expect(names(filterRecentByScope(E, OTHER))).toEqual(['package.json', 'legacy-out.ts']);
  });

  test('空表 / 脏数据不炸', () => {
    expect(filterRecentByScope([], WS)).toEqual([]);
    expect(filterRecentByScope([null as never, { name: 'a' } as never], WS)).toEqual([]);
  });
});
