import { describe, it, expect } from 'vitest';
import { LoopDetector, LoopLevel } from '../loopDetector';

const ORDERS = [
  ['.', 'TASK.md', 'src/inventory.js', 'src/store.js', 'test/basic.test.js', 'package.json'],
  ['.', 'TASK.md', 'package.json', 'src/store.js', 'src/inventory.js', 'test/basic.test.js'],
  ['TASK.md', '.', 'src/store.js', 'package.json', 'test/basic.test.js', 'src/inventory.js'],
];

describe('批量读的循环判定按文件集合算', () => {
  it('同一组文件换着顺序反复读 → 算循环', () => {
    const d = new LoopDetector();
    for (let i = 0; i < 4; i++) d.record('readfile', { paths: ORDERS[i % 3] }, 'success');
    expect(d.detect('readfile', { paths: ORDERS[1] })).not.toBe(LoopLevel.NONE);
  });

  it('读不同的文件组 → 不算', () => {
    const d = new LoopDetector();
    d.record('readfile', { paths: ['a.js', 'b.js'] }, 'success');
    d.record('readfile', { paths: ['c.js'] }, 'success');
    d.record('readfile', { paths: ['d.js', 'e.js'] }, 'success');
    expect(d.detect('readfile', { paths: ['f.js'] })).toBe(LoopLevel.NONE);
  });
});
