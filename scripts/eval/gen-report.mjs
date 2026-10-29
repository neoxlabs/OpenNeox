#!/usr/bin/env node
/**
 * gen-report — 一次报告出表, 并自动对比上一次 (code:EVAL-02)。
 *
 *   `scripts/eval/agent-bench.mjs` 每跑完一次就调这里: 打「指标均值」和「每题」两张表,
 *   每一项都跟 results/ 里上一次的报告比, 标出涨跌和好/差。也可以单独跑:
 *
 *     node scripts/eval/gen-report.mjs                    # 最新一次 vs 上一次
 *     node scripts/eval/gen-report.mjs results/a.json     # 指定报告 vs 上一次
 *     node scripts/eval/gen-report.mjs results/a.json --prev results/b.json
 *     node scripts/eval/gen-report.mjs --out report.md    # 同时写 markdown
 *
 *   涨跌方向: 通过率越高越好; 时长 / 轮数 / 工具调用 / token / 首字 / 白跑越低越好。
 *   只标涨跌, 不设门 (见 内部设计文档 原则 3)。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASTE_BUCKETS } from './lib/waste.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(SCRIPT_DIR, 'results');

/** 主指标定义 —— 报告和对比共用一份口径 */
export const METRICS = [
  { key: 'passRate', label: '通过率', mode: 'percent', higherBetter: true, read: (r) => r.summary?.passRate },
  { key: 'avgDurationMs', label: '时长', mode: 'seconds', higherBetter: false, read: (r) => r.summary?.avgDurationMs },
  { key: 'avgModelRequests', label: '轮数', mode: 'number', higherBetter: false, read: (r) => r.summary?.avgModelRequests },
  { key: 'avgToolCalls', label: '工具调用', mode: 'number', higherBetter: false, read: (r) => r.summary?.avgToolCalls },
  { key: 'avgInputTokens', label: '输入 tok', mode: 'tokens', higherBetter: false, read: (r) => r.summary?.avgInputTokens },
  { key: 'avgCacheHitTokens', label: '缓存 tok', mode: 'tokens', higherBetter: false, read: (r) => r.summary?.avgCacheHitTokens },
  { key: 'avgOutputTokens', label: '输出 tok', mode: 'tokens', higherBetter: false, read: (r) => r.summary?.avgOutputTokens },
  { key: 'avgFirstTokenMs', label: '首字', mode: 'seconds', higherBetter: false, read: (r) => r.summary?.avgFirstTokenMs },
];

/** 白跑四类 (EVAL-04) —— 统计单位见 lib/waste.mjs 头部 */
export const WASTE_METRICS = WASTE_BUCKETS.map((bucket) => ({
  key: bucket.key,
  label: bucket.label,
  mode: 'number',
  higherBetter: false,
}));

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

export function printTable(rows, headers) {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index]))),
  );
  const line = (cells) => cells.map((cell, index) => pad(cell, widths[index])).join('  ');
  console.log(line(headers));
  console.log(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

export function formatValue(value, mode) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (mode === 'percent') return `${Math.round(value * 100)}%`;
  if (mode === 'seconds') return `${(value / 1000).toFixed(1)}s`;
  if (mode === 'tokens') return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
  return String(Math.round(value * 10) / 10);
}

/** 涨跌单元格: `▲ +12pp 好` / `▼ -8% 差` / `— 持平`。无对比对象时 `—`。 */
export function formatDelta(before, after, mode, higherBetter) {
  if (typeof before !== 'number' || typeof after !== 'number' || !Number.isFinite(before) || !Number.isFinite(after)) {
    return '—';
  }
  const diff = after - before;
  const epsilon = mode === 'percent' ? 0.0005 : 0.0005 * Math.max(Math.abs(before), 1);
  if (Math.abs(diff) <= epsilon) return '— 持平';
  const arrow = diff > 0 ? '▲' : '▼';
  const better = higherBetter ? diff > 0 : diff < 0;
  const verdict = better ? '好' : '差';
  let amount;
  if (mode === 'percent') amount = `${Math.abs(diff * 100).toFixed(0)}pp`;
  else if (mode === 'seconds') amount = `${(Math.abs(diff) / 1000).toFixed(1)}s`;
  else if (mode === 'tokens') amount = Math.abs(diff) >= 1000 ? `${(Math.abs(diff) / 1000).toFixed(1)}k` : String(Math.round(Math.abs(diff)));
  else amount = String(Math.round(Math.abs(diff) * 10) / 10);
  return `${arrow} ${diff > 0 ? '+' : '-'}${amount} ${verdict}`;
}

export function loadReport(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`找不到报告: ${file}`);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

/** results/ 里按文件名 (时间戳) 排序的报告; 最新的一定在最后 */
export function listReports(dir = RESULTS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** 给当前报告找上一次 (排除它自己, 且文件名时间戳必须更早) */
export function findPreviousReport(currentFile, dir = RESULTS_DIR) {
  const current = path.resolve(currentFile);
  const currentName = path.basename(current);
  const reports = listReports(dir).filter((file) => {
    if (path.resolve(file) === current) return false;
    return path.basename(file) < currentName;
  });
  return reports.length ? reports[reports.length - 1] : null;
}

/** 白跑四类在整次报告里的合计 (按任务求和)。
 * 兼容两种写法: 明细分桶 map, 或 agent-bench 写的完整聚合对象 { turns, wasteTurns, buckets }。 */
export function wasteTotals(report) {
  const raw = report?.wasteTotals ?? report?.waste;
  if (raw?.buckets) {
    return Object.fromEntries(
      Object.entries(raw.buckets).map(([key, value]) => [key, typeof value?.turns === 'number' ? value.turns : null]),
    );
  }
  const totals = {};
  for (const metric of WASTE_METRICS) {
    let sum = null;
    for (const task of report?.tasks ?? []) {
      const turns = task.waste?.buckets?.[metric.key]?.turns;
      if (typeof turns === 'number') sum = (sum ?? 0) + turns;
    }
    totals[metric.key] = sum;
  }
  return totals;
}

function reportWasteTotals(report) {
  return report ? wasteTotals(report) : {};
}

/** 白跑轮次的合计值: 优先用去重后的 wasteTurns, 没有就用四类分桶之和 */
function reportWasteTurnCount(report) {
  const raw = report?.wasteTotals ?? report?.waste;
  if (typeof raw?.wasteTurns === 'number') return raw.wasteTurns;
  return Object.values(wasteTotals(report)).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
}

export function buildMetricRows(report, previous) {
  return METRICS.map((metric) => {
    const before = previous ? metric.read(previous) : null;
    const after = metric.read(report);
    return [metric.label, formatValue(before, metric.mode), formatValue(after, metric.mode), formatDelta(before, after, metric.mode, metric.higherBetter)];
  });
}

export function buildWasteRows(report, previous) {
  const before = reportWasteTotals(previous);
  const after = reportWasteTotals(report);
  return WASTE_METRICS.map((metric) => [
    metric.label,
    formatValue(before[metric.key], metric.mode),
    formatValue(after[metric.key], metric.mode),
    formatDelta(before[metric.key], after[metric.key], metric.mode, metric.higherBetter),
  ]);
}

export function buildTaskRows(report, previous) {
  const previousById = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
  return (report.tasks ?? []).map((task) => {
    const before = previousById.get(task.id);
    const waste = task.waste?.buckets ?? {};
    const wasteText = WASTE_BUCKETS.map((bucket) => `${bucket.label}${waste[bucket.key]?.turns ?? 0}`).join(' ');
    return [
      task.id,
      `${task.passCount}/${task.runCount}`,
      formatValue(task.avg?.avgDurationMs, 'seconds'),
      formatValue(task.avg?.avgModelRequests, 'number'),
      formatValue(task.avg?.avgToolCalls, 'number'),
      wasteText,
      before ? formatDelta(before.passRate, task.passRate, 'percent', true) : '— 新增',
    ];
  });
}

function metaLine(report) {
  const meta = report.meta ?? {};
  return `模型 ${meta.model ?? '?'} · provider ${meta.provider ?? '?'} · suite ${meta.suite ?? '?'} · repeat ${meta.repeat ?? '?'} · ${meta.startedAt ?? '?'}`;
}

/** 打印完整报告 (控制台), 返回 markdown 文本 */
export function renderReport(report, previous) {
  const title = `═══ 指标报告 · ${path.basename(report.meta?.reportPath ?? '') || (report.meta?.startedAt ?? '')} ═══`;
  console.log(title);
  console.log(metaLine(report));
  if (previous) console.log(`对比上次: ${previous.meta?.startedAt ?? '?'} (${previous.meta?.model ?? '?'})`);
  else console.log('对比上次: 没有更早的报告');

  console.log('\n指标均值');
  const metricRows = buildMetricRows(report, previous);
  printTable(metricRows, ['指标', '上次', '本次', '涨跌']);

  console.log('\n白跑轮次 (四类)');
  const wasteRows = buildWasteRows(report, previous);
  printTable(wasteRows, ['分桶', '上次', '本次', '涨跌']);
  console.log(`合计白跑轮次: ${reportWasteTurnCount(report)}`);

  console.log('\n每题');
  const taskRows = buildTaskRows(report, previous);
  printTable(taskRows, ['任务', '通过', '时长', '轮数', '工具', '白跑 (重读/穷举/空转/压缩后重读)', '通过率变化']);

  return renderMarkdown(report, previous, metricRows, wasteRows, taskRows);
}

export function renderMarkdown(report, previous, metricRows, wasteRows, taskRows) {
  const rows = metricRows ?? buildMetricRows(report, previous);
  const waste = wasteRows ?? buildWasteRows(report, previous);
  const tasks = taskRows ?? buildTaskRows(report, previous);
  const lines = [
    `# 指标报告`,
    '',
    metaLine(report),
    previous ? `对比上次: ${previous.meta?.startedAt ?? '?'}` : '对比上次: 无',
    '',
    '## 指标均值',
    '',
    '| 指标 | 上次 | 本次 | 涨跌 |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## 白跑轮次 (四类)',
    '',
    '| 分桶 | 上次 | 本次 | 涨跌 |',
    '|---|---|---|---|',
    ...waste.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## 每题',
    '',
    '| 任务 | 通过 | 时长 | 轮数 | 工具 | 白跑 (重读/穷举/空转/压缩后重读) | 通过率变化 |',
    '|---|---|---|---|---|---|---|',
    ...tasks.map((row) => `| ${row.join(' | ')} |`),
    '',
    '> 涨跌只做参考, 不设门 (LLM 结果有噪声)。',
    '',
  ];
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { report: null, prev: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--prev') options.prev = String(argv[++i] ?? '');
    else if (arg === '--out') options.out = String(argv[++i] ?? '');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('-')) options.report = arg;
    else throw new Error(`未知参数: ${arg} (--help 看用法)`);
  }
  return options;
}

function printHelp() {
  console.log(`指标报告 (EVAL-02)

  node scripts/eval/gen-report.mjs [报告.json] [--prev 更早.json] [--out report.md]

  不给报告文件时用 results/ 里最新的一份; 不给 --prev 时自动找它的上一次。
  对比上次会标涨跌 (▲/▼ + 好/差), 不设「不许退步」的闸。`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const file = options.report ?? listReports().at(-1);
  if (!file) throw new Error(`还没有报告 (${RESULTS_DIR}); 先跑 agent-bench.mjs`);
  const report = loadReport(file);
  report.meta = { ...(report.meta ?? {}), reportPath: file };
  const previous = options.prev
    ? loadReport(options.prev)
    : findPreviousReport(file)
      ? loadReport(findPreviousReport(file))
      : null;
  const markdown = renderReport(report, previous);
  if (options.out) {
    fs.writeFileSync(path.resolve(options.out), markdown);
    console.log(`\n报告已写: ${options.out}`);
  }
  return { report, previous, markdown };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`✖ ${error?.message ?? error}`);
    process.exit(1);
  });
}
