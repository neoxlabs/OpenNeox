import { describe, it, expect } from 'vitest';
import { LoopDetector, LoopLevel } from '../loopDetector';

const multi = (name: string) => ({ files: [{ file_path: `src/${name}.js`, content: `export const ${name} = 1;\n` }] });

describe('多文件 write_file 的循环判定', () => {
  it('四次写不同文件 → 不拦', () => {
    const d = new LoopDetector();
    for (const n of ['a', 'b', 'c']) d.record('write_file', multi(n), 'success');
    expect(d.detect('write_file', multi('d'))).not.toBe(LoopLevel.HARD);
  });

  it('edit edits=[...] 四次改不同文件 → 不拦', () => {
    const d = new LoopDetector();
    const ed = (n: string) => ({ edits: [{ file_path: `src/${n}.js`, old_string: 'a', new_string: n }] });
    for (const n of ['a', 'b', 'c']) d.record('edit', ed(n), 'success');
    expect(d.detect('edit', ed('d'))).not.toBe(LoopLevel.HARD);
  });

  it('同样的 (文件, 内容) 反复写 → 仍然算循环', () => {
    const d = new LoopDetector();
    for (let i = 0; i < 4; i++) d.record('write_file', multi('a'), 'success');
    expect(d.detect('write_file', multi('a'))).not.toBe(LoopLevel.NONE);
  });
});
