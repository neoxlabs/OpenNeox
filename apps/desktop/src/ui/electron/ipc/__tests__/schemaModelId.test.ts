import { describe, it, expect } from 'vitest';
import { schemaLookupCandidates, resolveSchemaModel, sortEffortLevels, KNOWN_EFFORT_LEVELS } from '../schemaModelId';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

describe('schemaLookupCandidates', () => {
  it('带 provider 前缀 → 先原样再剥前缀', () => {
    expect(schemaLookupCandidates('deepseek:deepseek-v4-flash'))
      .toEqual(['deepseek:deepseek-v4-flash', 'deepseek-v4-flash']);
  });

  it.each([
    ['订阅', 'neox-cloud:gpt-5.5', 'gpt-5.5'],
    ['自动路由', 'auto:or-free-auto', 'or-free-auto'],
    ['带连字符的 provider', 'my-openai-2:claude-opus-5', 'claude-opus-5'],
  ])('%s: %s → 候选含 %s', (_名, id, bare) => {
    expect(schemaLookupCandidates(id)).toContain(bare);
  });

  it('裸名不产生多余候选', () => {
    expect(schemaLookupCandidates('deepseek-v4-flash')).toEqual(['deepseek-v4-flash']);
  });

  it('特惠 / 经济版回落到本体, MiMo 补厂商前缀 (2026-10-21)', () => {
    const eco = schemaLookupCandidates('neox-cloud:deepseek-v4.1-flash-eco');
    expect(eco.slice(0, 2)).toEqual(['neox-cloud:deepseek-v4.1-flash-eco', 'deepseek-v4.1-flash-eco']);
    expect(eco).toContain('deepseek-v4.1-flash');
    expect(schemaLookupCandidates('neox-cloud:deepseek-v4.1-flash-promo')).toContain('deepseek-v4.1-flash');
    expect(schemaLookupCandidates('neox-cloud:mimo-v2.6-flash')).toContain('xiaomi/mimo-v2.6-flash');
  });

  it('模型名自带冒号时只剥第一段 (前缀只有一层)', () => {
    expect(schemaLookupCandidates('prov:a:b')).toEqual(['prov:a:b', 'a:b']);
  });

  it.each([['空串', ''], ['纯空白', '   '], ['只有冒号', ':'], ['前导冒号', ':x'], ['尾随冒号', 'x:']])
    ('边界 %s 不抛也不产生空候选', (_名, id) => {
      const out = schemaLookupCandidates(id);
      expect(out.every((x) => x.length > 0)).toBe(true);
    });
});

describe('resolveSchemaModel', () => {
  const registry = new Map([['deepseek-v4-flash', { id: 'deepseek-v4-flash' }]]);
  const resolve = (id: string) => registry.get(id);

  it('带前缀的 id 现在能解析出来 (这就是修的那个 bug)', () => {
    expect(resolveSchemaModel('deepseek:deepseek-v4-flash', resolve)).toEqual({ id: 'deepseek-v4-flash' });
  });

  it('裸名照常', () => {
    expect(resolveSchemaModel('deepseek-v4-flash', resolve)).toEqual({ id: 'deepseek-v4-flash' });
  });

  it('真的不存在 → null, 不抛', () => {
    expect(resolveSchemaModel('openai:nonexistent-model', resolve)).toBeNull();
  });

  it('原样命中优先于剥前缀 (yaml 里真有带冒号 id 时不被误剥)', () => {
    const r = new Map([['prov:x', { id: '原样' }], ['x', { id: '剥掉的' }]]);
    expect(resolveSchemaModel('prov:x', (id) => r.get(id))).toEqual({ id: '原样' });
  });
});

describe('sortEffortLevels · 从浅到深', () => {
  it('glm 的 off/on/max 排成 off → on → max', () => {
    expect(sortEffortLevels(['max', 'on', 'off'])).toEqual(['off', 'on', 'max']);
  });

  it('回归: on 曾经不在表里, 被排到 max 后面 (实拍 glm-5.2 显示 "Max 标准")', () => {
    expect(sortEffortLevels(['on', 'max']).indexOf('on')).toBeLessThan(sortEffortLevels(['on', 'max']).indexOf('max'));
  });

  it('doubao 的 off/auto/on', () => {
    expect(sortEffortLevels(['on', 'off', 'auto'])).toEqual(['off', 'auto', 'on']);
  });

  it('openai 的 minimal..ultra', () => {
    expect(sortEffortLevels(['ultra', 'high', 'minimal', 'xhigh', 'medium', 'low', 'max']))
      .toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('未知档位排到最后且彼此按字母序 (不崩不乱序)', () => {
    expect(sortEffortLevels(['zzz', 'max', 'aaa'])).toEqual(['max', 'aaa', 'zzz']);
  });

  it('不改入参', () => {
    const input = ['max', 'off'];
    sortEffortLevels(input);
    expect(input).toEqual(['max', 'off']);
  });
});

/**
 * 直接读 yaml 来守这张顺序表 —— 漏更新是必然会发生的 (加个模型就可能引入新档位),
 * 靠人记不住。新增档位时这条会指名道姓告诉你漏了哪个。
 */
describe('EFFORT_ORDER 必须覆盖 schemas/models/*.yaml 里出现过的全部档位', () => {
  const dir = pathResolve(__dirname, '../../../../../../../schemas/models');
  const yamlLevels = () => {
    const found = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
      const src = readFileSync(pathResolve(dir, f), 'utf8').replace(/\r\n/g, '\n');
      const m = src.match(/^effort_map:\n((?:[ \t]+.*\n|\n)*)/m);
      if (!m) continue;
      for (const k of m[1]!.matchAll(/^ {2}([A-Za-z_0-9]+):/gm)) found.add(k[1]!);
    }
    return [...found].sort();
  };

  it('夹具有效性: 真的从 yaml 里读到了档位 (否则整条是空跑)', () => {
    expect(yamlLevels().length).toBeGreaterThan(5);
  });

  it('没有 yaml 档位漏在表外', () => {
    const missing = yamlLevels().filter((l) => !KNOWN_EFFORT_LEVELS.includes(l));
    expect(missing, `这些档位出现在 schemas/models/*.yaml 但不在 EFFORT_ORDER 里, 会被排到列表最后。请按"思考由浅到深"插进 schemaModelId.ts 的 EFFORT_ORDER`).toEqual([]);
  });
});
