import { describe, test, expect } from 'vitest';
import { pickSlashItems } from '../TimelineComposer';

const mk = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `/${prefix}${i}` })) as never[];

describe('pickSlashItems', () => {
  test('内置再多也挤不掉技能 —— 技能保底占一半', () => {
    const out = pickSlashItems(mk(20, 'b'), mk(20, 's'), 12);
    expect(out).toHaveLength(12);
    const skills = out.filter((x) => x.id.startsWith('s'));
    /* 老实现是 [...builtins, ...skills].slice(0, max) → skills 一条都不剩 */
    expect(skills.length).toBe(6);
    /* 内置仍排在前面 */
    expect(out[0]!.id).toBe('b0');
  });

  test('技能不够时内置补满, 不留空位', () => {
    const out = pickSlashItems(mk(20, 'b'), mk(2, 's'), 12);
    expect(out).toHaveLength(12);
    expect(out.filter((x) => x.id.startsWith('s'))).toHaveLength(2);
    expect(out.filter((x) => x.id.startsWith('b'))).toHaveLength(10);
  });

  test('内置不够时技能补满', () => {
    const out = pickSlashItems(mk(3, 'b'), mk(20, 's'), 12);
    expect(out).toHaveLength(12);
    expect(out.filter((x) => x.id.startsWith('b'))).toHaveLength(3);
    expect(out.filter((x) => x.id.startsWith('s'))).toHaveLength(9);
  });

  test('两边加起来没到上限就全给', () => {
    const out = pickSlashItems(mk(3, 'b'), mk(4, 's'), 12);
    expect(out).toHaveLength(7);
  });
});
