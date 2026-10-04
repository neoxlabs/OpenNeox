/**
 * 网关错误目录的中英文对齐闸。
 *
 *   CATALOGUE_EN 必须为每个中文错误条目提供对应文案，避免不同语言目录发生漂移。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { presentNeoxError, setNeoxErrorLanguage, getNeoxErrorLanguage } from '../neoxErrorCatalogue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, '../neoxErrorCatalogue.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** 抓某张表里每个 code 的字段集合 */
function tableFields(varName: string): Map<string, Set<string>> {
  const start = src.indexOf(`const ${varName}`);
  expect(start, `找不到 ${varName}`).toBeGreaterThan(-1);
  const end = src.indexOf('\n};', start);
  const body = src.slice(start, end);
  const out = new Map<string, Set<string>>();
  /* 两张表的**书写形态不同**: 中文表是多行块, 英文表是单行。
   *   第一版正则只认多行块 ⇒ 英文表解析出 0 条, 而"缺英文"那条断言就会把 36 个 code 全报成缺失。
   *   (幸好上面留了"解析出的条数必须 >30"这条反假绿断言 —— 否则反过来若中文表解析成 0,
   *    这条闸会**静默全绿**。) 改成按 code 起点切片, 到下一个 code 或表尾为止, 与排版无关。 */
  const starts = [...body.matchAll(/'([a-z][a-z0-9_.]+)'\s*:\s*\{/g)];
  starts.forEach((m, i) => {
    const from = m.index ?? 0;
    const to = i + 1 < starts.length ? (starts[i + 1].index ?? body.length) : body.length;
    const blk = body.slice(from, to);
    const fields = new Set<string>();
    for (const f of ['title', 'message', 'messageFallback']) {
      if (new RegExp(`\\b${f}:\\s*'`).test(blk)) fields.add(f);
    }
    if (/label:\s*'/.test(blk)) fields.add('label');
    out.set(m[1], fields);
  });
  return out;
}

describe('网关错误目录 zh / en 对齐', () => {
  const zh = tableFields('CATALOGUE');
  const en = tableFields('CATALOGUE_EN');

  it('两张表都解析出了一批 code —— 解析失败要红, 不能静默变成"都对齐了"', () => {
    expect(zh.size).toBeGreaterThan(30);
    expect(en.size).toBeGreaterThan(30);
  });

  it('每个中文 code 都有英文 —— 漏一个就是英文界面上蹦中文', () => {
    const missing = [...zh.keys()].filter((k) => !en.has(k));
    expect(missing, `缺英文: ${missing.join(', ')}`).toEqual([]);
  });

  it('英文表里不许有中文表没有的 code —— 那种条目永远查不到', () => {
    const ghost = [...en.keys()].filter((k) => !zh.has(k));
    expect(ghost, `中文表没有: ${ghost.join(', ')}`).toEqual([]);
  });

  it('同一个 code 两边的字段集合一致 —— 中文有 label 英文没有, 按钮就会是空白', () => {
    const bad: string[] = [];
    for (const [code, f] of zh) {
      const e = en.get(code);
      if (!e) continue;
      const zOnly = [...f].filter((x) => !e.has(x));
      const eOnly = [...e].filter((x) => !f.has(x));
      if (zOnly.length || eOnly.length) bad.push(`${code} (zh独有:${zOnly} en独有:${eOnly})`);
    }
    expect(bad, `字段不齐: ${bad.join(' | ')}`).toEqual([]);
  });

  it('英文表里不许残留中文', () => {
    const start = src.indexOf('const CATALOGUE_EN');
    const body = src.slice(start, src.indexOf('\n};', start));
    const han = body.match(/[一-龥]+/g) ?? [];
    expect(han, `英文表里有中文: ${han.slice(0, 5).join(' / ')}`).toEqual([]);
  });
});

describe('presentNeoxError 按语言出文案', () => {
  it('默认仍是中文 —— 没有调用方设置语言时行为不变', () => {
    expect(getNeoxErrorLanguage()).toBe('zh');
    const p = presentNeoxError({ code: 'quota.exhausted' } as never);
    expect(p.title).toBe('额度已用尽');
  });

  it('切到英文后 title / message / action.label 三处都跟着走', () => {
    const p = presentNeoxError({ code: 'quota.exhausted' } as never, 'en');
    expect(p.title).toBe('Usage limit reached');
    expect(p.message).not.toMatch(/[一-龥]/);
    expect(p.action?.label).toBe('See plans');
  });

  it('占位符降级在英文下也走英文 fallback, 不会串回中文', () => {
    const p = presentNeoxError({ code: 'model.not_allowed' } as never, 'en');
    expect(p.message).not.toMatch(/[一-龥]/);
    expect(p.message).not.toMatch(/\{\w+\}/);
  });

  it('setNeoxErrorLanguage 之后不传参也出英文', () => {
    setNeoxErrorLanguage('en');
    try {
      expect(presentNeoxError({ code: 'auth.required' } as never).title).toBe('Sign in required');
    } finally {
      setNeoxErrorLanguage('zh');
    }
  });
});
