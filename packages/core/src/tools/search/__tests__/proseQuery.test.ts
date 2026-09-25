/**
 * 自然语言查询扩展 — 行为锁
 *
 * Content mode searches the supplied pattern first. A zero-match query with
 * natural-language shape may then expand into terms and identifiers.
 */
import { describe, it, expect } from 'vitest';
import {
  looksLikeProseQuery,
  splitQueryTerms,
  identifierVariants,
  stemTerm,
  expandProseQuery,
  cjkBigrams,
} from '../queryUtils.js';

describe('looksLikeProseQuery — 该扩展的才扩展', () => {
  it('多词英文短语 → 是自然语言', () => {
    expect(looksLikeProseQuery('always active tools')).toBe(true);
    expect(looksLikeProseQuery('compaction trigger threshold')).toBe(true);
  });

  it('无空格的中文复合词 → 也是自然语言 (最初漏掉这类, 8 个未命中里占 7 个)', () => {
    expect(looksLikeProseQuery('日志目录清理')).toBe(true);
    expect(looksLikeProseQuery('读文件按行切分')).toBe(true);
  });

  it('单个标识符 → 不碰 (本来就搜得到)', () => {
    expect(looksLikeProseQuery('ALWAYS_ACTIVE_TOOLS')).toBe(false);
    expect(looksLikeProseQuery('recoverMatch')).toBe(false);
  });

  it('显式正则 → 尊重原意, 绝不扩展', () => {
    expect(looksLikeProseQuery('export function \\w+')).toBe(false);
    expect(looksLikeProseQuery('foo|bar')).toBe(false);
    expect(looksLikeProseQuery('a.*b')).toBe(false);
    expect(looksLikeProseQuery('handle(Click|Tap)')).toBe(false);
  });
});

describe('切词', () => {
  it('拉丁按空白切', () => {
    expect(splitQueryTerms('always active tools')).toEqual(['always', 'active', 'tools']);
  });

  it('CJK 与拉丁混排要切开', () => {
    expect(splitQueryTerms('编码探测 BOM')).toContain('BOM');
  });

  it('CJK 连续块拆成重叠 2-gram (无词典分词的折中)', () => {
    expect(cjkBigrams('日志目录')).toEqual(['日志', '志目', '目录']);
    expect(cjkBigrams('日志')).toEqual(['日志']);
  });
});

describe('标识符拼法', () => {
  it('多词 → 覆盖常见命名惯例', () => {
    const v = identifierVariants(['always', 'active', 'tools']);
    expect(v).toContain('always_active_tools');
    expect(v).toContain('alwaysActiveTools');
    expect(v).toContain('ALWAYS_ACTIVE_TOOLS');
    expect(v).toContain('AlwaysActiveTools');
  });

  it('少于两个拉丁词 → 不造标识符 (避免噪音)', () => {
    expect(identifierVariants(['tools'])).toEqual([]);
    expect(identifierVariants(['日志', '目录'])).toEqual([]);
  });
});

describe('词根退化', () => {
  it('长英文词剥常见后缀', () => {
    expect(stemTerm('compaction')).toBe('compact');
    expect(stemTerm('threshold')).toBeNull();   // 无可剥后缀
  });

  it('短词不动 (剥了会过度泛化)', () => {
    expect(stemTerm('tools')).toBeNull();
    expect(stemTerm('abc')).toBeNull();
  });
});

describe('softMinHits — CJK 噪音容忍', () => {
  it('纯拉丁要求全中', () => {
    const e = expandProseQuery('always active tools');
    expect(e.softMinHits).toBe(e.terms.length);
  });

  it('含 CJK 只要求多数 (2-gram 必然含跨词边界的噪音项)', () => {
    const e = expandProseQuery('日志目录清理');
    expect(e.softMinHits).toBeLessThan(e.terms.length);
    expect(e.softMinHits).toBeGreaterThanOrEqual(2);
  });
});
