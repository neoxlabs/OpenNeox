/**
 * W2 ToolAccesses 单元测试
 *
 * 覆盖:
 *   - accessesConflict: 同 resource × 各 kind 组合
 *   - setsConflict: 笛卡尔积 / 空 set
 *   - scheduleByAccess: 调度算法稳定 + 贪心打包正确
 *   - 辅助函数: read/write/exclusive/accessSet/EMPTY_ACCESS_SET
 */

import { describe, it, expect } from 'vitest';
import {
  accessesConflict,
  setsConflict,
  scheduleByAccess,
  read,
  write,
  exclusive,
  accessSet,
  EMPTY_ACCESS_SET,
  type ToolAccessSet,
} from '../toolAccesses.js';

// ============================================================================
// accessesConflict — 双对冲突矩阵
// ============================================================================

describe('accessesConflict', () => {
  it('不同 resource → 永不冲突', () => {
    expect(accessesConflict(read('A'), write('B'))).toBe(false);
    expect(accessesConflict(write('A'), write('B'))).toBe(false);
    expect(accessesConflict(exclusive('A'), exclusive('B'))).toBe(false);
  });

  it('同 resource read+read → 不冲突', () => {
    expect(accessesConflict(read('A'), read('A'))).toBe(false);
  });

  it('同 resource read+write → 冲突', () => {
    expect(accessesConflict(read('A'), write('A'))).toBe(true);
    expect(accessesConflict(write('A'), read('A'))).toBe(true);
  });

  it('同 resource write+write → 冲突', () => {
    expect(accessesConflict(write('A'), write('A'))).toBe(true);
  });

  it('exclusive 跟同 resource 任意 kind 都冲突', () => {
    expect(accessesConflict(exclusive('A'), read('A'))).toBe(true);
    expect(accessesConflict(exclusive('A'), write('A'))).toBe(true);
    expect(accessesConflict(exclusive('A'), exclusive('A'))).toBe(true);
  });

  it('resource 大小写敏感', () => {
    expect(accessesConflict(read('A'), write('a'))).toBe(false);
  });
});

// ============================================================================
// setsConflict
// ============================================================================

describe('setsConflict', () => {
  it('空 set 跟任何 set 不冲突', () => {
    expect(setsConflict(EMPTY_ACCESS_SET, accessSet(write('A')))).toBe(false);
    expect(setsConflict(accessSet(write('A')), EMPTY_ACCESS_SET)).toBe(false);
    expect(setsConflict(EMPTY_ACCESS_SET, EMPTY_ACCESS_SET)).toBe(false);
  });

  it('两 set 笛卡尔积任一对冲突 → 冲突', () => {
    const s1 = accessSet(read('A'), read('B'));
    const s2 = accessSet(write('B'));  // 跟 read('B') 冲突
    expect(setsConflict(s1, s2)).toBe(true);
  });

  it('两 set 笛卡尔积全无冲突 → 不冲突', () => {
    const s1 = accessSet(read('A'), read('B'));
    const s2 = accessSet(read('A'), read('C'));  // 全 read, 不同 resource
    expect(setsConflict(s1, s2)).toBe(false);
  });
});

// ============================================================================
// scheduleByAccess — 调度算法
// ============================================================================

describe('scheduleByAccess', () => {
  /* 用 string 当 item 类型简化测试; getSet 用 closure */
  function makeGetSet(map: Record<string, ToolAccessSet>) {
    return (item: string) => map[item] ?? EMPTY_ACCESS_SET;
  }

  it('空 input → 空输出', () => {
    expect(scheduleByAccess([], () => EMPTY_ACCESS_SET)).toEqual([]);
  });

  it('全 read 同 resource → 一个 batch', () => {
    const items = ['r1', 'r2', 'r3'];
    const get = makeGetSet({
      r1: accessSet(read('A')),
      r2: accessSet(read('A')),
      r3: accessSet(read('A')),
    });
    expect(scheduleByAccess(items, get)).toEqual([['r1', 'r2', 'r3']]);
  });

  it('一 read + 一 write 同 resource → 两个 batch (read 先)', () => {
    const get = makeGetSet({
      readA: accessSet(read('A')),
      writeA: accessSet(write('A')),
    });
    expect(scheduleByAccess(['readA', 'writeA'], get)).toEqual([['readA'], ['writeA']]);
  });

  it('read+read 同 resource + 一个 read 不同 resource → 全打包一个 batch', () => {
    const get = makeGetSet({
      readA: accessSet(read('A')),
      readA2: accessSet(read('A')),
      readB: accessSet(read('B')),
    });
    expect(scheduleByAccess(['readA', 'readA2', 'readB'], get))
      .toEqual([['readA', 'readA2', 'readB']]);
  });

  it('writeA + readB + writeA → 第 3 个 writeA 跟 batch0 里 writeA 冲突, 单独成 batch', () => {
    const get = makeGetSet({
      writeA1: accessSet(write('A')),
      readB: accessSet(read('B')),
      writeA2: accessSet(write('A')),
    });
    /* batch0: [writeA1, readB] — 不同 resource 不冲突
     * batch1: [writeA2] — 跟 batch0 里 writeA1 冲突 */
    expect(scheduleByAccess(['writeA1', 'readB', 'writeA2'], get))
      .toEqual([['writeA1', 'readB'], ['writeA2']]);
  });

  it('exclusive 跟同 resource 任何访问冲突', () => {
    const get = makeGetSet({
      exA: accessSet(exclusive('A')),
      readA: accessSet(read('A')),
      readB: accessSet(read('B')),
    });
    /* batch0: [exA, readB] — exA 跟 readB 不同 resource 不冲突
     * batch1: [readA] — 跟 exA 同 resource 冲突 */
    expect(scheduleByAccess(['exA', 'readB', 'readA'], get))
      .toEqual([['exA', 'readB'], ['readA']]);
  });

  it('保持输入顺序在 batch 内 (稳定调度)', () => {
    const get = makeGetSet({
      r1: accessSet(read('A')),
      r2: accessSet(read('A')),
      r3: accessSet(read('A')),
      r4: accessSet(read('A')),
    });
    expect(scheduleByAccess(['r1', 'r2', 'r3', 'r4'], get))
      .toEqual([['r1', 'r2', 'r3', 'r4']]);
  });

  it('无 access 声明 (空 set) 跟谁都不冲突 → 永远进 batch0', () => {
    const get = makeGetSet({
      writeA: accessSet(write('A')),
      mystery: EMPTY_ACCESS_SET,    // 无声明
      writeA2: accessSet(write('A')),
    });
    expect(scheduleByAccess(['writeA', 'mystery', 'writeA2'], get))
      .toEqual([['writeA', 'mystery'], ['writeA2']]);
  });

  it('多个写不同资源 → 全打包一个 batch', () => {
    const get = makeGetSet({
      writeA: accessSet(write('A')),
      writeB: accessSet(write('B')),
      writeC: accessSet(write('C')),
    });
    expect(scheduleByAccess(['writeA', 'writeB', 'writeC'], get))
      .toEqual([['writeA', 'writeB', 'writeC']]);
  });

  it('复杂场景: 文件编辑 + dev server + npm install 冲突调度', () => {
    /* 模拟一轮 LLM 同时发: 改 a.ts, 改 b.ts, 启 dev server (port 5173),
     * 跑 npm install (锁 lock:npm), 读 package.json */
    const get = makeGetSet({
      edit_a: accessSet(write('/a.ts')),
      edit_b: accessSet(write('/b.ts')),
      dev_server: accessSet(exclusive('port:5173')),
      npm_install: accessSet(exclusive('lock:npm'), read('/package.json')),
      read_pkg: accessSet(read('/package.json')),
    });
    /* batch0: [edit_a, edit_b, dev_server, npm_install] — 全不冲突 (不同 resource)
     * batch1: [read_pkg] — 跟 npm_install 里 read('/package.json') ?? wait
     *    npm_install 含 read('/package.json'), read_pkg 也是 read('/package.json'),
     *    read+read 不冲突 → 应该也进 batch0 */
    expect(scheduleByAccess(['edit_a', 'edit_b', 'dev_server', 'npm_install', 'read_pkg'], get))
      .toEqual([['edit_a', 'edit_b', 'dev_server', 'npm_install', 'read_pkg']]);
  });

  it('writeA × 5 → 5 个 batch (每个单独)', () => {
    const items = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const get = makeGetSet(
      Object.fromEntries(items.map((k) => [k, accessSet(write('A'))])),
    );
    const batches = scheduleByAccess(items, get);
    expect(batches).toEqual([['w1'], ['w2'], ['w3'], ['w4'], ['w5']]);
  });
});

// ============================================================================
// 辅助函数
// ============================================================================

describe('helper constructors', () => {
  it('read/write/exclusive 构造正确', () => {
    expect(read('A')).toEqual({ kind: 'read', resource: 'A' });
    expect(write('A')).toEqual({ kind: 'write', resource: 'A' });
    expect(exclusive('A')).toEqual({ kind: 'exclusive', resource: 'A' });
  });

  it('accessSet 接收变参', () => {
    expect(accessSet(read('A'), write('B'))).toEqual({
      accesses: [
        { kind: 'read', resource: 'A' },
        { kind: 'write', resource: 'B' },
      ],
    });
  });

  it('EMPTY_ACCESS_SET 为空 accesses array', () => {
    expect(EMPTY_ACCESS_SET.accesses).toEqual([]);
  });
});
