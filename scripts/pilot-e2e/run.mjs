#!/usr/bin/env node
/*
 * Q-03: 5 个基准任务一条命令跑完, 输出成功率与耗时。
 *
 *   node scripts/pilot-e2e/run.mjs
 *   node scripts/pilot-e2e/run.mjs --repeat 5
 *   node scripts/pilot-e2e/run.mjs --tasks wechat-reply,parcel-status
 *   node scripts/pilot-e2e/run.mjs --no-json
 *
 * 退出码: 全部通过 = 0, 有失败 = 1。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_TASKS } from './lib/tasks.mjs';
import { runPilotBench } from './lib/runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = { repeat: 3, taskIds: [], json: null, noJson: false, keepTemp: false, help: false, bad: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repeat') opts.repeat = Number(argv[++i]);
    else if (arg === '--tasks') opts.taskIds = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--json') opts.json = String(argv[++i] ?? '');
    else if (arg === '--no-json') opts.noJson = true;
    else if (arg === '--keep-temp') opts.keepTemp = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      console.error(`未知参数: ${arg}`);
      opts.help = true;
      opts.bad = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`用法: node scripts/pilot-e2e/run.mjs [选项]

  --repeat <n>     每个任务跑几次 (默认 3)
  --tasks <ids>    只跑指定任务, 逗号分隔
  --json <path>    结果写到指定文件
  --no-json        不写结果文件
  --keep-temp      保留每次运行的临时工作目录
  -h, --help

任务: ${BENCH_TASKS.map((t) => `${t.id} (${t.title})`).join(', ')}`);
}

function pct(n) {
  return `${(n * 100).toFixed(0)}%`;
}

function printReport(result) {
  console.log('');
  console.log(`Pilot 基准集 · ${result.mode} · 每任务 ${result.repeat} 次`);
  console.log('');
  console.log('任务                      成功      成功率   P50      P90');
  console.log('------------------------  --------  ------  -------  -------');
  for (const task of result.tasks) {
    const name = `${task.title} (${task.id})`.padEnd(24, ' ');
    const ok = `${task.passed}/${task.runCount}`.padEnd(8, ' ');
    console.log(`${name}  ${ok}  ${pct(task.successRate).padEnd(6, ' ')}  ${String(task.p50Ms).padStart(5)}ms  ${String(task.p90Ms).padStart(5)}ms`);
  }
  console.log('------------------------  --------  ------  -------  -------');
  const t = result.totals;
  console.log(`总计: ${t.passed}/${t.runs} 成功 (${pct(t.successRate)}), P50 ${t.p50Ms}ms, P90 ${t.p90Ms}ms, 总墙钟 ${t.durationMs}ms`);
  const failures = result.tasks.flatMap((task) => task.runs.filter((r) => !r.success).map((r) => ({ task, r })));
  if (failures.length) {
    console.log('');
    console.log('失败明细:');
    for (const { task, r } of failures) console.log(`  - ${task.id}: ${r.reason}`);
  }
  console.log('');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return opts.bad ? 2 : 0;
  }
  const result = await runPilotBench({
    repeat: opts.repeat,
    taskIds: opts.taskIds,
    keepTemp: opts.keepTemp,
    onRun(task, run, i) {
      const mark = run.success ? '✓' : '✗';
      console.log(`${mark} ${task.id} #${i + 1}  ${run.durationMs}ms${run.success ? '' : `  ${run.reason}`}`);
    },
  });
  printReport(result);

  if (!opts.noJson) {
    const out = opts.json || join(HERE, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(result, null, 2));
    console.log(`结果已写入 ${out}`);
  }
  return result.totals.failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
