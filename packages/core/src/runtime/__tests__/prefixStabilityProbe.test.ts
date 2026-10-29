import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  recordSystemPrefix,
  recordPrefixTokenUsage,
  getPrefixStabilityStats,
  readPrefixStabilityStats,
  formatPrefixStabilityLine,
  __resetPrefixStabilityProbeForTests,
} from '../prefixStabilityProbe.js';

/* PROMPT-07 的验收口径就两条: 同会话连续 5 轮 system 哈希不变; 缓存命中率看得见。
 * 看板本身是纯度量 —— 这里锁的是「数算得对」, 而不是「拦住了谁」。 */
describe('prefix stability probe (PROMPT-07)', () => {
  beforeEach(() => {
    __resetPrefixStabilityProbeForTests();
  });

  it('同会话连续 5 轮相同 system → systemHashChanges = 0', () => {
    for (let i = 0; i < 5; i++) {
      recordSystemPrefix('s1', '你是 Neox\n\n## 规则\n不要虚构');
    }
    const stats = getPrefixStabilityStats('s1');
    expect(stats?.turns).toBe(5);
    expect(stats?.systemHashChanges).toBe(0);
  });

  it('内容变了只记一次变化, 并记住新的字节数', () => {
    recordSystemPrefix('s1', 'A');
    recordSystemPrefix('s1', 'A');
    recordSystemPrefix('s1', 'BB');
    recordSystemPrefix('s1', 'BB');
    const stats = getPrefixStabilityStats('s1');
    expect(stats?.turns).toBe(4);
    expect(stats?.systemHashChanges).toBe(1);
    expect(stats?.systemChars).toBe(2);
  });

  it('缓存命中率按累计 input 汇总 (与预算记账同口径: input 已含缓存部分)', () => {
    recordPrefixTokenUsage('s1', 1000, 800);
    recordPrefixTokenUsage('s1', 2000, 1600);
    const stats = getPrefixStabilityStats('s1');
    expect(stats?.inputTokens).toBe(3000);
    expect(stats?.cacheHitTokens).toBe(2400);
    expect(stats?.cacheHitRate).toBeCloseTo(0.8, 4);
  });

  it('缓存命中数不会超过 input (脏用量不把命中率算到 100% 以上)', () => {
    recordPrefixTokenUsage('s1', 100, 500);
    expect(getPrefixStabilityStats('s1')?.cacheHitRate).toBe(1);
  });

  it('没有记录时返回 null, /stats 不硬编一行 0', () => {
    expect(getPrefixStabilityStats('nope')).toBeNull();
  });

  it('会话之间互不影响', () => {
    recordSystemPrefix('a', 'same');
    recordSystemPrefix('b', 'same');
    recordSystemPrefix('b', 'other');
    expect(getPrefixStabilityStats('a')?.systemHashChanges).toBe(0);
    expect(getPrefixStabilityStats('b')?.systemHashChanges).toBe(1);
  });

  it('/stats 的一行摘要: 中英文都带轮数 / 变更次数 / 命中率', () => {
    recordSystemPrefix('s1', 'A');
    recordSystemPrefix('s1', 'A');
    recordPrefixTokenUsage('s1', 1000, 900);
    const stats = getPrefixStabilityStats('s1')!;
    expect(formatPrefixStabilityLine(stats, true)).toBe('2 轮 · system 变更 0 次 · 缓存命中 90%');
    expect(formatPrefixStabilityLine(stats, false)).toBe('2 turns · 0 system changes · 90% cached');
  });

  describe('落盘记录跨进程聚合 (/stats 读的就是它)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'neox-prefix-probe-'));
      process.env.NEOX_PREFIX_PROBE_FILE = join(dir, 'prefix-stability.jsonl');
    });
    afterEach(() => {
      delete process.env.NEOX_PREFIX_PROBE_FILE;
      rmSync(dir, { recursive: true, force: true });
    });

    it('只汇总指定会话, 并算出变更次数与命中率', () => {
      writeFileSync(process.env.NEOX_PREFIX_PROBE_FILE!, [
        JSON.stringify({ t: 1, s: 's1', k: 'turn', h: 'a', c: 100, ch: 0 }),
        JSON.stringify({ t: 2, s: 's1', k: 'usage', i: 1000, cache: 900 }),
        JSON.stringify({ t: 3, s: 's1', k: 'turn', h: 'b', c: 120, ch: 1 }),
        JSON.stringify({ t: 4, s: 's1', k: 'usage', i: 500, cache: 400 }),
        JSON.stringify({ t: 5, s: 's2', k: 'turn', h: 'x', c: 1, ch: 0 }),
      ].join('\n') + '\n');

      const stats = readPrefixStabilityStats('s1');
      expect(stats?.turns).toBe(2);
      expect(stats?.systemHashChanges).toBe(1);
      expect(stats?.systemChars).toBe(120);
      expect(stats?.cacheHitRate).toBeCloseTo(1300 / 1500, 4);
      expect(readPrefixStabilityStats('missing')).toBeNull();
    });

    it('文件不存在时安静返回 null (看板不能把 /stats 弄崩)', () => {
      expect(readPrefixStabilityStats('s1')).toBeNull();
    });
  });

  it('没有样本时不给出一行空数据', () => {
    expect(formatPrefixStabilityLine({
      sessionId: 's', turns: 0, systemHashChanges: 0, systemChars: 0,
      inputTokens: 0, cacheHitTokens: 0, cacheHitRate: null,
    }, true)).toBe('');
  });
});
