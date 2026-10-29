import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildWasteRows,
  findPreviousReport,
  formatDelta,
  renderMarkdown,
  wasteTotals,
} from '../eval/gen-report.mjs';
import { aggregateWaste } from '../eval/agent-bench.mjs';

function report(overrides = {}) {
  return {
    meta: { model: 'deepseek-v4.1-flash-1017', provider: 'neox-cloud', startedAt: '2026-10-18T00:00:00Z' },
    summary: {
      passRate: 0.8,
      avgDurationMs: 60_000,
      avgModelRequests: 8,
      avgToolCalls: 12,
      avgInputTokens: 50_000,
      avgCacheHitTokens: 20_000,
      avgOutputTokens: 1_000,
      avgFirstTokenMs: 2_000,
    },
    tasks: [
      {
        id: 'code-fix-slug',
        passCount: 1,
        runCount: 1,
        passRate: 1,
        avg: { avgDurationMs: 60_000, avgModelRequests: 8, avgToolCalls: 12 },
        waste: { buckets: { reread: { turns: 2 }, exhaustive: { turns: 1 }, idle: { turns: 0 }, rereadAfterCompact: { turns: 3 } } },
      },
    ],
    ...overrides,
  };
}

test('formatDelta: 通过率涨是「好」, 时长涨是「差」', () => {
  assert.equal(formatDelta(0.6, 0.8, 'percent', true), '▲ +20pp 好');
  assert.equal(formatDelta(60_000, 90_000, 'seconds', false), '▲ +30.0s 差');
  assert.equal(formatDelta(90_000, 60_000, 'seconds', false), '▼ -30.0s 好');
  assert.equal(formatDelta(8, 8, 'number', false), '— 持平');
  assert.equal(formatDelta(null, 8, 'number', false), '—');
});

test('wasteTotals: 四类分桶按任务求和', () => {
  const totals = wasteTotals(report());
  assert.deepEqual(totals, { reread: 2, exhaustive: 1, idle: 0, rereadAfterCompact: 3 });
});

test('wasteTotals: 兼容 agent-bench 写的完整聚合对象', () => {
  const totals = wasteTotals({
    wasteTotals: {
      turns: 9,
      wasteTurns: 4,
      buckets: {
        reread: { turns: 2, calls: 3 },
        exhaustive: { turns: 1, calls: 1 },
        idle: { turns: 0, calls: 0 },
        rereadAfterCompact: { turns: 1, calls: 2 },
      },
    },
  });
  assert.deepEqual(totals, { reread: 2, exhaustive: 1, idle: 0, rereadAfterCompact: 1 });
});

test('白跑对比表含四类, 并标涨跌', () => {
  const previous = report({
    tasks: [
      {
        id: 'code-fix-slug',
        passCount: 1,
        runCount: 1,
        passRate: 1,
        avg: {},
        waste: { buckets: { reread: { turns: 1 }, exhaustive: { turns: 1 }, idle: { turns: 2 }, rereadAfterCompact: { turns: 0 } } },
      },
    ],
  });
  const rows = buildWasteRows(report(), previous);
  const labels = rows.map((row) => row[0]);
  assert.deepEqual(labels, ['重读', '穷举', '空转', '压缩后重读']);
  const reread = rows.find((row) => row[0] === '重读');
  assert.equal(reread[1], '1');
  assert.equal(reread[2], '2');
  assert.equal(reread[3], '▲ +1 差');
});

test('markdown 报告含指标均值、白跑四类、每题三张表', () => {
  const md = renderMarkdown(report(), null);
  assert.match(md, /## 指标均值/);
  assert.match(md, /## 白跑轮次 \(四类\)/);
  assert.match(md, /## 每题/);
  assert.match(md, /压缩后重读/);
  assert.match(md, /code-fix-slug/);
  assert.match(md, /对比上次: 无/);
});

test('findPreviousReport: 取当前报告之前最近的一份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-report-'));
  try {
    const older = join(dir, '20260101-000000.json');
    const current = join(dir, '20260102-000000.json');
    writeFileSync(older, '{}');
    writeFileSync(current, '{}');
    assert.equal(findPreviousReport(current, dir), older);
    assert.equal(findPreviousReport(older, dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateWaste: 多次 run 的分桶按轮数相加, 并算 wasteRate', () => {
  const runs = [
    {
      waste: {
        turns: 6,
        wasteTurns: 2,
        buckets: {
          reread: { turns: 1, calls: 2 },
          exhaustive: { turns: 0, calls: 0 },
          idle: { turns: 1 },
          rereadAfterCompact: { turns: 0, calls: 0 },
        },
      },
    },
    {
      waste: {
        turns: 4,
        wasteTurns: 2,
        buckets: {
          reread: { turns: 1, calls: 1 },
          exhaustive: { turns: 1, calls: 3 },
          idle: { turns: 0 },
          rereadAfterCompact: { turns: 0, calls: 0 },
        },
      },
    },
    { waste: null },
  ];
  const total = aggregateWaste(runs);
  assert.equal(total.turns, 10);
  assert.equal(total.wasteTurns, 4);
  assert.equal(total.wasteRate, 0.4);
  assert.deepEqual(total.buckets.reread, { turns: 2, calls: 3 });
  assert.deepEqual(total.buckets.exhaustive, { turns: 1, calls: 3 });
});
