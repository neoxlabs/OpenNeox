import { describe, expect, it } from 'vitest';
import {
  FileHotspotDetector,
  isMutationTool,
  FILE_HOTSPOT_WINDOW_MS,
  FILE_HOTSPOT_R1_THRESHOLD,
  FILE_HOTSPOT_R2_THRESHOLD,
  FILE_HOTSPOT_R3_THRESHOLD,
} from '../fileHotspotDetector.js';

describe('isMutationTool', () => {
  it('recognizes mutation-class tool names (snake + PascalCase)', () => {
    expect(isMutationTool('edit_file')).toBe(true);
    expect(isMutationTool('edit')).toBe(true);
    expect(isMutationTool('write_file')).toBe(true);
    expect(isMutationTool('write')).toBe(true);
    expect(isMutationTool('multi_edit')).toBe(true);
    /* Claude Code PascalCase remap 后的等价名 */
    expect(isMutationTool('Edit')).toBe(true);
    expect(isMutationTool('Write')).toBe(true);
    expect(isMutationTool('MultiEdit')).toBe(true);
  });

  it('excludes read/search/shell/other tools', () => {
    expect(isMutationTool('readfile')).toBe(false);
    expect(isMutationTool('Read')).toBe(false);
    expect(isMutationTool('search')).toBe(false);
    expect(isMutationTool('execute_shell')).toBe(false);
    expect(isMutationTool('Bash')).toBe(false);
    expect(isMutationTool('agent')).toBe(false);
  });
});

describe('FileHotspotDetector', () => {
  it('returns none for the first few touches (below r1 threshold)', () => {
    const d = new FileHotspotDetector();
    const t0 = 1_000_000;
    for (let i = 1; i < FILE_HOTSPOT_R1_THRESHOLD; i++) {
      const r = d.recordAndCheck('/a/b.html', t0 + i * 100);
      expect(r.level).toBe('none');
      expect(r.reminder).toBeNull();
    }
  });

  it('fires r1 exactly at threshold (5th touch)', () => {
    const d = new FileHotspotDetector();
    const t0 = 1_000_000;
    let last;
    for (let i = 0; i < FILE_HOTSPOT_R1_THRESHOLD; i++) {
      last = d.recordAndCheck('/a/b.html', t0 + i * 100);
    }
    expect(last!.count).toBe(FILE_HOTSPOT_R1_THRESHOLD);
    expect(last!.level).toBe('r1');
    expect(last!.reminder).toContain('<system-reminder>');
    expect(last!.reminder).toContain('5 分钟内对');
    expect(last!.reminder).toContain('反复改了 5 次');
  });

  it('escalates to r2 at count=8', () => {
    const d = new FileHotspotDetector();
    const t0 = 1_000_000;
    let last;
    for (let i = 0; i < FILE_HOTSPOT_R2_THRESHOLD; i++) {
      last = d.recordAndCheck('/a/b.html', t0 + i * 100);
    }
    expect(last!.count).toBe(FILE_HOTSPOT_R2_THRESHOLD);
    expect(last!.level).toBe('r2');
    expect(last!.reminder).toContain('警告');
    expect(last!.reminder).toContain('已经对');
  });

  it('escalates to r3 at count>=12, then every 3 more', () => {
    const d = new FileHotspotDetector();
    const t0 = 1_000_000;
    let last;
    for (let i = 0; i < FILE_HOTSPOT_R3_THRESHOLD; i++) {
      last = d.recordAndCheck('/a/b.html', t0 + i * 100);
    }
    expect(last!.count).toBe(FILE_HOTSPOT_R3_THRESHOLD);
    expect(last!.level).toBe('r3');
    expect(last!.forceStop).toBe(false); // 软提示不硬拦

    /* 再 2 次不应触发 (每 3 次触发一次) */
    d.recordAndCheck('/a/b.html', t0 + 13 * 100);
    const r14 = d.recordAndCheck('/a/b.html', t0 + 14 * 100);
    expect(r14.level).toBe('none');
    /* 第 15 次应触发 (12 + 3) */
    const r15 = d.recordAndCheck('/a/b.html', t0 + 15 * 100);
    expect(r15.level).toBe('r3');
  });

  it('sliding window drops old touches (>5min)', () => {
    const d = new FileHotspotDetector();
    const t0 = 1_000_000;
    /* 打满 4 次 (还没到 r1) */
    for (let i = 0; i < 4; i++) {
      d.recordAndCheck('/a/b.html', t0 + i * 100);
    }
    /* 时间跳过窗口 + 1 次 */
    const rLate = d.recordAndCheck('/a/b.html', t0 + FILE_HOTSPOT_WINDOW_MS + 1000);
    /* 老 timestamp 被剥, 只剩这一次 */
    expect(rLate.count).toBe(1);
    expect(rLate.level).toBe('none');
  });

  it('per-file counters are independent', () => {
    const d = new FileHotspotDetector();
    const t0 = 1_000_000;
    /* file A 打满 5 次 → r1 */
    for (let i = 0; i < FILE_HOTSPOT_R1_THRESHOLD; i++) {
      d.recordAndCheck('/a/foo.ts', t0 + i * 100);
    }
    /* file B 触发一次不应受 A 影响 */
    const rB = d.recordAndCheck('/a/bar.ts', t0 + 10000);
    expect(rB.count).toBe(1);
    expect(rB.level).toBe('none');
  });

  it('reset() clears all state', () => {
    const d = new FileHotspotDetector();
    const t0 = 1_000_000;
    for (let i = 0; i < FILE_HOTSPOT_R2_THRESHOLD; i++) {
      d.recordAndCheck('/a/b.html', t0 + i * 100);
    }
    d.reset();
    const r = d.recordAndCheck('/a/b.html', t0 + 999999);
    expect(r.count).toBe(1);
    expect(r.level).toBe('none');
    expect(d.getStats().trackedFiles).toBe(1); // 刚 record 一次
  });

  it('empty filePath returns none, no crash', () => {
    const d = new FileHotspotDetector();
    expect(d.recordAndCheck('').level).toBe('none');
  });

  /* Distinct edit regions are progress; only repeated overlapping edits count. */
  it('edits in different regions of one file are progress, not a hotspot', () => {
    const d = new FileHotspotDetector();
    const t0 = 1_000_000;
    let last;
    for (let i = 0; i < 12; i++) {
      last = d.recordAndCheck('/a/page.dart', t0 + i * 100, [{ start: 100 + i * 80, end: 110 + i * 80 }]);
      expect(last.reminder).toBeNull();
    }
    expect(last!.level).toBe('none');
  });

  it('re-editing the same lines still triggers the reminder', () => {
    const d = new FileHotspotDetector();
    const t0 = 1_000_000;
    let last;
    for (let i = 0; i <= FILE_HOTSPOT_R1_THRESHOLD; i++) {
      last = d.recordAndCheck('/a/page.dart', t0 + i * 100, [{ start: 200 + i, end: 205 + i }]);
    }
    expect(last!.level).not.toBe('none');
  });
});
