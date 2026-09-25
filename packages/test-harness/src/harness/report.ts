import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Scenario, ScenarioResult } from '../types.js';

export type RunReport = {
  startedAt: string;
  finishedAt?: string;
  filter: Record<string, string | undefined>;
  results: Array<{
    id: string;
    module: string;
    mode: string;
    title: string;
    status: 'pass' | 'fail' | 'skip' | 'manual';
    result?: ScenarioResult;
  }>;
  summary: { pass: number; fail: number; skip: number; manual: number; total: number };
};

export function emptyReport(filter: Record<string, string | undefined>): RunReport {
  return {
    startedAt: new Date().toISOString(),
    filter,
    results: [],
    summary: { pass: 0, fail: 0, skip: 0, manual: 0, total: 0 },
  };
}

export function pushResult(
  report: RunReport,
  scenario: Scenario,
  status: RunReport['results'][0]['status'],
  result?: ScenarioResult,
): void {
  report.results.push({
    id: scenario.id,
    module: scenario.module,
    mode: scenario.mode,
    title: scenario.title,
    status,
    result,
  });
  report.summary.total += 1;
  report.summary[status] += 1;
}

export function finishReport(report: RunReport, outDir: string): string {
  report.finishedAt = new Date().toISOString();
  mkdirSync(outDir, { recursive: true });
  const path = resolve(outDir, 'report.json');
  writeFileSync(path, JSON.stringify(report, null, 2));
  /* 同时生成面向人的摘要；JSON 保留给机器处理。 */
  writeFileSync(resolve(outDir, 'report.md'), renderMarkdown(report));
  return path;
}

/** 报告的 markdown 版: 结论 + 每条用例的耗时/token + 失败详情。 */
export function renderMarkdown(report: RunReport): string {
  const { pass, fail, skip, manual, total } = report.summary;
  const ran = report.results.filter((r) => r.status === 'pass' || r.status === 'fail');
  const tok = (r: (typeof report.results)[number]): number | null => {
    const v = (r.result?.detail as Record<string, unknown> | undefined)?.tokens;
    return typeof v === 'number' ? v : null;
  };
  const ms = (r: (typeof report.results)[number]): number | null => {
    const v = (r.result?.detail as Record<string, unknown> | undefined)?.durationMs;
    return typeof v === 'number' ? v : null;
  };
  const totalTokens = ran.reduce((n, r) => n + (tok(r) ?? 0), 0);
  const measured = ran.filter((r) => tok(r) !== null).length;
  const totalMs = ran.reduce((n, r) => n + (ms(r) ?? 0), 0);
  const fmtTok = (n: number | null): string =>
    n === null ? '-' : n >= 1_000_000 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

  const lines: string[] = [];
  lines.push(`# neox-test 报告`);
  lines.push('');
  lines.push(`- 开始: ${report.startedAt}`);
  lines.push(`- 结束: ${report.finishedAt ?? '-'}`);
  lines.push(`- 结果: **${pass} pass · ${fail} fail** · ${skip} skip · ${manual} manual / ${total}`);
  lines.push(`- 自动跑的用例耗时合计: ${(totalMs / 1000).toFixed(1)}s`);
  lines.push(
    `- token 合计: **${fmtTok(totalTokens)}** (${measured}/${ran.length} 条测到)`,
  );
  lines.push(
    '  - 口径: 每条用例都新建会话再跑, 这里记的是**它跑完时该会话的累计上下文** (界面上那句「共消耗」)。',
  );
  lines.push(
    '  - 含缓存读, 不等于账单; 用途是横向比较用例量级、发现"某条突然贵了三倍"这类回归。',
  );
  lines.push('');
  if (fail > 0) {
    lines.push('## 失败');
    lines.push('');
    for (const r of report.results.filter((x) => x.status === 'fail')) {
      lines.push(`### ${r.id}`);
      lines.push(`${r.title}`);
      if (r.result?.error) lines.push(`- 原因: ${r.result.error}`);
      if (r.result?.detail) lines.push(`- 现场: \`${JSON.stringify(r.result.detail).slice(0, 500)}\``);
      lines.push('');
    }
  }
  lines.push('## 明细');
  lines.push('');
  lines.push('| 用例 | 结果 | 耗时 | token | 模型 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of ran) {
    const model = (r.result?.detail as Record<string, unknown> | undefined)?.model;
    lines.push(
      `| ${r.id} | ${r.status === 'pass' ? '✅' : '❌'} | ${ms(r) === null ? '-' : `${(ms(r)! / 1000).toFixed(1)}s`} | ${fmtTok(tok(r))} | ${typeof model === 'string' ? model : '-'} |`,
    );
  }
  if (skip + manual > 0) {
    lines.push('');
    lines.push(`> 另有 ${skip} 条 skip、${manual} 条 manual (人工核对清单, 不计入结论)。`);
  }
  lines.push('');
  return lines.join('\n');
}

export function printSummary(report: RunReport): void {
  const { pass, fail, skip, manual, total } = report.summary;
  console.log(`\nneox-test: ${pass} pass · ${fail} fail · ${skip} skip · ${manual} manual / ${total}`);
  for (const row of report.results.filter((r) => r.status === 'fail')) {
    console.log(`  FAIL ${row.id}  ${row.title}`);
    if (row.result?.error) console.log(`       ${row.result.error}`);
    if (row.result?.note) console.log(`       ${row.result.note}`);
  }
}
