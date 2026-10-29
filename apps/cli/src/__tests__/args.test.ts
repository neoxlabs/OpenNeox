import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';

/**
 * `--keep-orphans` 解析 (TERM-08)。
 *
 * 这个参数的分量不在解析本身, 而在它必须**默认关闭**: 用户不加参数时启动清扫要正常收尸,
 * 只有显式要求才保留。默认值错了就是"孤儿再也清不掉"或者"服务每次启动都被杀"。
 */
describe('parseArgs --keep-orphans', () => {
  it('默认不开 (启动时会清孤儿)', () => {
    expect(parseArgs(['node', 'neox']).keepOrphans).toBeUndefined();
  });

  it('--keep-orphans 打开', () => {
    expect(parseArgs(['node', 'neox', '--keep-orphans']).keepOrphans).toBe(true);
  });

  it('跟其它参数混用不互相干扰', () => {
    const args = parseArgs(['node', 'neox', '--keep-orphans', '--model', 'x', 'hello']);
    expect(args.keepOrphans).toBe(true);
    expect(args.model).toBe('x');
    expect(args._).toEqual(['hello']);
  });
});
