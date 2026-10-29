/**
 * sectionRegistry 单元测试
 *
 * 覆盖:
 *   - 拼装顺序 = stable → context → volatile (同 layer 内按注册顺序)
 *   - volatile 后置: volatile 内容变化不影响 stable 前缀字节 (work H-15)
 *   - layer 决定 cache 策略 (volatile 每次重算 / stable+context 按 cacheKeyFields 缓存)
 *   - enabledWhen 跳过逻辑
 *   - injectInPromptStyle filter (codex_official 不注入 layered 专属 section)
 *   - 三层独立字段 (stable / context / volatile) 与 full 一致性
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerSection,
  buildPrompt,
  clearSectionCache,
  __resetForTests,
  type SectionInput,
} from '../sectionRegistry.js';

afterEach(() => {
  __resetForTests();
});

const baseInput: SectionInput = {
  workDir: '/tmp/neox',
  language: 'zh',
  promptStyle: 'layered',
};

describe('sectionRegistry', () => {
  it('按 layer 分段拼装 (stable → context → volatile)', () => {
    /* volatile 注册在前, stable 注册在后 — 输出按 layer 重排, volatile 后置 */
    registerSection({ name: 'A-volatile', layer: 'volatile', compute: () => 'A' });
    registerSection({ name: 'B-stable', layer: 'stable', compute: () => 'B' });
    registerSection({ name: 'C-volatile', layer: 'volatile', compute: () => 'C' });

    const r = buildPrompt(baseInput);
    expect(r.full).toBe('B\n\nA\n\nC');
    expect(r.sectionsRendered).toEqual(['B-stable', 'A-volatile', 'C-volatile']);
  });

  it('三层独立字段按 layer 聚合', () => {
    registerSection({ name: 's1', layer: 'stable', compute: () => 'S1' });
    registerSection({ name: 'v1', layer: 'volatile', compute: () => 'V1' });
    registerSection({ name: 'c1', layer: 'context', compute: () => 'C1' });
    registerSection({ name: 's2', layer: 'stable', compute: () => 'S2' });

    const r = buildPrompt(baseInput);
    expect(r.stable).toBe('S1\n\nS2');
    expect(r.context).toBe('C1');
    expect(r.volatile).toBe('V1');
    /* full 也按 layer: stable → context → volatile */
    expect(r.full).toBe('S1\n\nS2\n\nC1\n\nV1');
  });

  it('volatile 内容变化时 stable 前缀字节不变 (H-15)', () => {
    let profile = '画像A';
    registerSection({ name: 's1', layer: 'stable', compute: () => 'STABLE-1' });
    registerSection({ name: 'p-profile', layer: 'volatile', compute: () => profile });
    registerSection({ name: 'c1', layer: 'context', compute: () => 'CTX' });
    registerSection({ name: 's2', layer: 'stable', compute: () => 'STABLE-2' });

    const a = buildPrompt(baseInput);
    profile = '画像B';
    const b = buildPrompt(baseInput);

    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(a.stable).toBe('STABLE-1\n\nSTABLE-2');
    expect(b.stable).toBe(a.stable);
    expect(hash(b.stable)).toBe(hash(a.stable));
    /* full 以 stable 开头, volatile 落在最后 */
    expect(b.full.startsWith(b.stable)).toBe(true);
    expect(b.full.endsWith('画像B')).toBe(true);
    expect(a.full.endsWith('画像A')).toBe(true);
  });

  it('stable layer 缓存命中: 相同 cacheKeyFields 值不重算', () => {
    let computed = 0;
    registerSection({
      name: 'cached',
      layer: 'stable',
      compute: () => { computed++; return 'X'; },
      cacheKeyFields: ['language'],
    });

    buildPrompt(baseInput);
    buildPrompt(baseInput);
    buildPrompt(baseInput);
    expect(computed).toBe(1);  // 三次调用只算一次
  });

  it('stable layer cacheKeyFields 变化时重算', () => {
    let computed = 0;
    registerSection({
      name: 'cached',
      layer: 'stable',
      compute: (i) => { computed++; return `lang:${i.language}`; },
      cacheKeyFields: ['language'],
    });

    buildPrompt({ ...baseInput, language: 'zh' });
    buildPrompt({ ...baseInput, language: 'en' });
    buildPrompt({ ...baseInput, language: 'zh' });   // 再回 zh — 命中
    expect(computed).toBe(2);                         // zh + en
  });

  it('volatile layer 每次都算 (不入 cache)', () => {
    let computed = 0;
    registerSection({
      name: 'volatile-only',
      layer: 'volatile',
      compute: () => { computed++; return 'V'; },
      cacheKeyFields: ['language'],   // 即使指定也忽略
    });

    buildPrompt(baseInput);
    buildPrompt(baseInput);
    buildPrompt(baseInput);
    expect(computed).toBe(3);
  });

  it('enabledWhen=false 跳过 compute 调用', () => {
    let computed = 0;
    registerSection({
      name: 'gated',
      layer: 'stable',
      compute: () => { computed++; return 'X'; },
      enabledWhen: (i) => i.workDir === '/never',
    });

    const r = buildPrompt(baseInput);
    expect(computed).toBe(0);
    expect(r.sectionsRendered).toEqual([]);
    expect(r.full).toBe('');
  });

  it('injectInPromptStyle 限制: codex_official 模式跳过 layered-only section', () => {
    registerSection({
      name: 'layered-only',
      layer: 'stable',
      compute: () => 'LAYERED',
      injectInPromptStyle: ['layered'],
    });
    registerSection({
      name: 'all-style',
      layer: 'stable',
      compute: () => 'ALL',
    });

    expect(buildPrompt({ ...baseInput, promptStyle: 'layered' }).full)
      .toBe('LAYERED\n\nALL');
    expect(buildPrompt({ ...baseInput, promptStyle: 'codex_official' }).full)
      .toBe('ALL');
    expect(buildPrompt({ ...baseInput, promptStyle: 'kimi' }).full)
      .toBe('ALL');
  });

  it('null / 空字符串 compute 结果不进输出', () => {
    registerSection({ name: 'null', layer: 'stable', compute: () => null });
    registerSection({ name: 'empty', layer: 'stable', compute: () => '' });
    registerSection({ name: 'spaces', layer: 'stable', compute: () => '   \n  ' });
    registerSection({ name: 'real', layer: 'stable', compute: () => 'X' });

    const r = buildPrompt(baseInput);
    expect(r.full).toBe('X');
    expect(r.sectionsRendered).toEqual(['real']);
  });

  it('clearSectionCache 清掉特定 layer 后下次重算', () => {
    let computed = 0;
    registerSection({
      name: 'a',
      layer: 'stable',
      compute: () => { computed++; return 'A'; },
      cacheKeyFields: ['language'],
    });

    buildPrompt(baseInput);
    expect(computed).toBe(1);

    buildPrompt(baseInput);
    expect(computed).toBe(1);  // 命中

    clearSectionCache('stable');
    buildPrompt(baseInput);
    expect(computed).toBe(2);  // 再算
  });

  it('clearSectionCache(undefined) 清全部', () => {
    let a = 0, b = 0;
    registerSection({ name: 'a', layer: 'stable', compute: () => { a++; return 'A'; }, cacheKeyFields: ['language'] });
    registerSection({ name: 'b', layer: 'context', compute: () => { b++; return 'B'; }, cacheKeyFields: ['language'] });

    buildPrompt(baseInput);
    expect(a).toBe(1);
    expect(b).toBe(1);

    clearSectionCache();
    buildPrompt(baseInput);
    expect(a).toBe(2);
    expect(b).toBe(2);
  });

  it('重复注册同 name 覆盖前者 + 清相关 cache', () => {
    let v1 = 0, v2 = 0;
    registerSection({ name: 'x', layer: 'stable', compute: () => { v1++; return 'V1'; } });
    buildPrompt(baseInput);
    expect(v1).toBe(1);

    /* 覆盖 — 新 compute */
    registerSection({ name: 'x', layer: 'stable', compute: () => { v2++; return 'V2'; } });
    const r = buildPrompt(baseInput);
    expect(r.full).toBe('V2');
    expect(v2).toBe(1);
    expect(v1).toBe(1);  // 老 compute 不再调
  });

  it('cacheStats 反映 hits/misses', () => {
    registerSection({ name: 'a', layer: 'stable', compute: () => 'A', cacheKeyFields: ['language'] });
    registerSection({ name: 'b', layer: 'stable', compute: () => 'B', cacheKeyFields: ['language'] });

    const r1 = buildPrompt(baseInput);
    expect(r1.cacheStats).toEqual({ hits: 0, misses: 2 });

    const r2 = buildPrompt(baseInput);
    expect(r2.cacheStats).toEqual({ hits: 2, misses: 0 });
  });
});
