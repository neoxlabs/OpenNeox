#!/usr/bin/env node
/**
 * Agent 效果基线 —— 改 agent 循环 / 提示词 / 工具前后, 拿同一批任务跑一遍对比。
 *
 * 设计约束 (见 内部设计文档 原则 3):
 *   - 只建一套度量, 指标先拿来看, 不做「不许退步」的 CI 门 —— LLM 结果有噪声;
 *   - 判分只看磁盘真相和真实用量, 不看模型自称完成;
 *   - 每个任务在临时目录里跑, 永远不碰当前仓库。
 *
 * 用法:
 *   node scripts/eval/agent-bench.mjs
 *   node scripts/eval/agent-bench.mjs --tasks fix-slugify,chat-http-codes --repeat 2
 *   node scripts/eval/agent-bench.mjs --compare results/a.json results/b.json
 *
 * 详见 scripts/eval/README.md。
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunMetrics } from './lib/metrics.mjs';
import { readWasteStats } from './lib/waste.mjs';
import { findPreviousReport as findPreviousReportFile, loadReport as loadReportFile, renderReport as renderMetricsReport, WASTE_METRICS } from './gen-report.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(SCRIPT_DIR, 'tasks');
const RESULTS_DIR = path.join(SCRIPT_DIR, 'results');
const CHECK_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_SEC = 600;

function parseArgs(argv) {
  const options = {
    tasks: null,
    suite: 'full',
    repeat: 1,
    cli: 'neox',
    model: 'deepseek-v4.1-flash-1017',
    provider: 'neox-cloud',
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    compare: null,
    keepTemp: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tasks') {
      options.tasks = String(argv[++i] ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    } else if (arg === '--suite') {
      options.suite = String(argv[++i] ?? 'full');
    } else if (arg === '--repeat') {
      options.repeat = Math.max(1, Number(argv[++i] ?? 1) || 1);
    } else if (arg === '--cli') {
      options.cli = String(argv[++i] ?? '');
    } else if (arg === '--model') {
      options.model = String(argv[++i] ?? '');
    } else if (arg === '--provider') {
      options.provider = String(argv[++i] ?? '');
    } else if (arg === '--timeout') {
      options.timeoutSec = Math.max(1, Number(argv[++i] ?? DEFAULT_TIMEOUT_SEC));
    } else if (arg === '--compare') {
      options.compare = [String(argv[++i] ?? ''), String(argv[++i] ?? '')];
    } else if (arg === '--keep-temp') {
      options.keepTemp = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数: ${arg} (--help 看用法)`);
    }
  }
  if (options.suite !== 'quick' && options.suite !== 'full') {
    throw new Error(`--suite 只能是 quick 或 full, 收到 ${options.suite}`);
  }
  return options;
}

function printHelp() {
  console.log(`Agent 效果基线

  node scripts/eval/agent-bench.mjs [选项]

  --tasks a,b        只跑指定任务 (逗号分隔, 默认全部)
  --suite quick|full 任务集: quick = 合并闸用的 10 题, full = 全部 30 题 (默认)
  --repeat N         每个任务跑 N 遍 (默认 1; 判断效果变化建议 >= 3)
  --cli <path>       neox 可执行文件 (默认 PATH 里的 neox)
  --model <id>       模型 (默认 deepseek-v4.1-flash-1017)
  --provider <id>    provider (默认 neox-cloud)
  --timeout <sec>    单任务超时秒数 (默认 600)
  --keep-temp        保留临时工作目录, 方便看模型到底改了什么
  --compare a b      不跑任务, 直接对比两份报告

  结果写到 scripts/eval/results/<时间>.json, 同时在终端打一张表。`);
}

function listTasks() {
  if (!fs.existsSync(TASKS_DIR)) throw new Error(`找不到任务目录: ${TASKS_DIR}`);
  return fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => loadTask(id));
}

function loadTask(id) {
  const dir = path.join(TASKS_DIR, id);
  const manifestPath = path.join(dir, 'task.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`任务 ${id} 缺少 task.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const promptPath = path.join(dir, 'prompt.md');
  if (!fs.existsSync(promptPath)) throw new Error(`任务 ${id} 缺少 prompt.md`);
  const checkPath = path.join(dir, 'check.mjs');
  if (!fs.existsSync(checkPath)) throw new Error(`任务 ${id} 缺少 check.mjs`);
  return {
    id,
    dir,
    title: manifest.title ?? id,
    kind: manifest.kind ?? 'code',
    quick: manifest.quick === true,
    timeoutSec: manifest.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    fixtureDir: fs.existsSync(path.join(dir, 'fixture')) ? path.join(dir, 'fixture') : null,
    genPath: fs.existsSync(path.join(dir, 'gen.mjs')) ? path.join(dir, 'gen.mjs') : null,
    promptPath,
    checkPath,
  };
}

function copyDir(source, target) {
  fs.cpSync(source, target, { recursive: true });
}

function parsePrintOutput(stdout) {
  const text = String(stdout ?? '').trim();
  const candidates = [text, ...text.split('\n').filter((line) => line.trim().startsWith('{')).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && 'result' in parsed) {
        return { answer: typeof parsed.result === 'string' ? parsed.result : '', error: parsed.error ?? null, structured: true };
      }
    } catch {
      /* 继续找下一行 */
    }
  }
  return { answer: text, error: null, structured: false };
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let firstOutputMs = null;
    const startedAt = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (firstOutputMs === null) firstOutputMs = Date.now() - startedAt;
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (firstOutputMs === null) firstOutputMs = Date.now() - startedAt;
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut,
        durationMs: Date.now() - startedAt,
        firstOutputMs,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt, firstOutputMs });
    });
  });
}

async function runOnce(task, options, runIndex) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `agent-bench-${task.id}-`));
  const workdir = path.join(tempRoot, 'work');
  fs.mkdirSync(workdir, { recursive: true });

  if (task.fixtureDir) copyDir(task.fixtureDir, workdir);
  if (task.genPath) {
    const gen = spawnSync(process.execPath, [task.genPath, workdir], {
      cwd: workdir,
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (gen.status !== 0) {
      throw new Error(`fixture 生成失败 (${task.id}): ${(gen.stderr ?? '').slice(-1500)}`);
    }
  }

  const dbPath = path.join(tempRoot, 'neox.db');
  const answerPath = path.join(tempRoot, 'answer.txt');
  const prompt = fs.readFileSync(task.promptPath, 'utf8').trim();
  const timeoutMs = task.timeoutSec * 1000;

  /* --cli 给的是仓库里刚编的 main.js (没有 shebang, 不能直接 spawn) → 用 node 跑 */
  const cliIsJs = /\.(c|m)?js$/.test(options.cli);
  /* 相对路径要按启动目录解析 —— 下面 cwd 换成了任务临时目录 */
  const cliPath = cliIsJs ? path.resolve(options.cli) : options.cli;
  const run = await runProcess(
    cliIsJs ? process.execPath : cliPath,
    [
      ...(cliIsJs ? [cliPath] : []),
      '-p',
      '--yolo',
      '--provider',
      options.provider,
      '-m',
      options.model,
      '--json',
      '--timeout',
      String(task.timeoutSec),
      prompt,
    ],
    {
      cwd: workdir,
      /* NEOX_DB_ENCRYPT=0: Node 版 CLI 默认 SQLCipher 加密会话库, lib/metrics.mjs 用 node:sqlite 读不了
       * (每题都报 file is not a database, 表现成 0 轮 0% 的假失败) */
      env: { ...process.env, NEOX_DB_PATH: dbPath, NEOX_BENCH_TASK: task.id, NEOX_DB_ENCRYPT: '0' },
      timeoutMs,
    },
  );

  const parsed = parsePrintOutput(run.stdout);
  fs.writeFileSync(answerPath, `${parsed.answer}\n`);

  const metrics = await readRunMetrics(dbPath);
  /* 白跑四类 (EVAL-04): 读同一次 run 的会话库, 数重读/穷举/空转/压缩后重读 */
  const waste = await readWasteStats(dbPath);

  const check = spawnSync(process.execPath, [task.checkPath, workdir], {
    cwd: workdir,
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
    env: {
      ...process.env,
      BENCH_OUTPUT_FILE: answerPath,
      BENCH_DB_PATH: dbPath,
      BENCH_TEMP_DIR: tempRoot,
      BENCH_TASK_ID: task.id,
      BENCH_MODEL: options.model,
    },
  });

  const checkOutput = `${check.stdout ?? ''}${check.stderr ?? ''}`.trim();
  const checkExit = check.status;
  const pass = !run.timedOut && run.code === 0 && checkExit === 0;

  const record = {
    run: runIndex + 1,
    pass,
    timedOut: run.timedOut,
    exitCode: run.code,
    durationMs: run.durationMs,
    firstOutputMs: run.firstOutputMs,
    modelRequests: metrics.modelRequests,
    toolCalls: metrics.toolCalls,
    toolFailures: metrics.toolFailures,
    inputTokens: metrics.inputTokens,
    cacheHitTokens: metrics.cacheHitTokens,
    outputTokens: metrics.outputTokens,
    firstTokenMs: metrics.firstTokenMs ?? run.firstOutputMs,
    metricsSource: metrics.source,
    agentDurationMs: metrics.agentDurationMs,
    waste,
    checkExit,
    checkOutput: checkOutput.slice(-2000),
    answerTail: parsed.answer.slice(-600),
    modelError: parsed.error ?? null,
    tempRoot: options.keepTemp ? tempRoot : null,
  };

  if (!options.keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true });
  return record;
}

function average(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

/** 把一次任务的多次 run 的白跑分桶按轮数合计 (EVAL-04) */
export function aggregateWaste(runs) {
  const buckets = {};
  for (const metric of WASTE_METRICS) buckets[metric.key] = { turns: 0, calls: 0 };
  let turns = 0;
  let wasteTurns = 0;
  let idleSource = null;
  for (const run of runs) {
    if (!run.waste) continue;
    turns += run.waste.turns ?? 0;
    wasteTurns += run.waste.wasteTurns ?? 0;
    idleSource = run.waste.idleSource ?? idleSource;
    for (const metric of WASTE_METRICS) {
      buckets[metric.key].turns += run.waste.buckets?.[metric.key]?.turns ?? 0;
      buckets[metric.key].calls += run.waste.buckets?.[metric.key]?.calls ?? 0;
    }
  }
  return {
    turns,
    wasteTurns,
    wasteRate: turns ? Number((wasteTurns / turns).toFixed(3)) : 0,
    buckets,
    idleSource,
  };
}

function summarizeRuns(runs) {
  return {
    passRate: runs.length ? runs.filter((run) => run.pass).length / runs.length : 0,
    avgDurationMs: average(runs.map((run) => run.durationMs)),
    avgModelRequests: average(runs.map((run) => run.modelRequests)),
    avgToolCalls: average(runs.map((run) => run.toolCalls)),
    avgInputTokens: average(runs.map((run) => run.inputTokens)),
    avgCacheHitTokens: average(runs.map((run) => run.cacheHitTokens)),
    avgOutputTokens: average(runs.map((run) => run.outputTokens)),
    avgFirstTokenMs: average(runs.map((run) => run.firstTokenMs)),
  };
}

function charWidth(char) {
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
  return wide ? 2 : 1;
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += charWidth(char);
  return width;
}

function pad(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function formatSeconds(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return String(Math.round(value * 10) / 10);
}

function printTable(rows, headers) {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index]))),
  );
  const line = (cells) => cells.map((cell, index) => pad(cell, widths[index])).join('  ');
  console.log(line(headers));
  console.log(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

function writeReport(report) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const file = path.join(RESULTS_DIR, `${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

async function runBench(options) {
  const allTasks = listTasks();
  let tasks = options.suite === 'quick' ? allTasks.filter((task) => task.quick) : allTasks;
  if (options.tasks?.length) {
    const wanted = new Set(options.tasks);
    const missing = [...wanted].filter((id) => !allTasks.some((task) => task.id === id));
    if (missing.length) throw new Error(`未知任务: ${missing.join(', ')}`);
    tasks = tasks.filter((task) => wanted.has(task.id));
  }
  if (!tasks.length) throw new Error(`suite=${options.suite} 下没有任务`);

  console.log(`模型: ${options.model} (provider=${options.provider})`);
  console.log(`CLI: ${options.cli}  suite=${options.suite}  任务: ${tasks.length} 个  repeat=${options.repeat}\n`);

  const startedAt = new Date().toISOString();
  const results = [];
  let index = 0;
  for (const task of tasks) {
    index += 1;
    const runs = [];
    for (let runIndex = 0; runIndex < options.repeat; runIndex += 1) {
      process.stdout.write(`▶ ${task.id} (${index}/${tasks.length}) run ${runIndex + 1}/${options.repeat} … `);
      let record;
      try {
        record = await runOnce(task, options, runIndex);
      } catch (error) {
        record = {
          run: runIndex + 1,
          pass: false,
          timedOut: false,
          exitCode: null,
          durationMs: null,
          firstOutputMs: null,
          modelRequests: null,
          toolCalls: null,
          toolFailures: null,
          inputTokens: null,
          cacheHitTokens: null,
          outputTokens: null,
          firstTokenMs: null,
          metricsSource: null,
          agentDurationMs: null,
          waste: null,
          checkExit: null,
          checkOutput: `运行失败: ${error?.message ?? error}`.slice(-2000),
          answerTail: '',
          modelError: String(error?.message ?? error),
          tempRoot: null,
        };
      }
      runs.push(record);
      const mark = record.pass ? '✅' : '❌';
      console.log(`${mark} ${formatSeconds(record.durationMs)}  轮数 ${formatCount(record.modelRequests)}  工具 ${formatCount(record.toolCalls)}`);
    }
    results.push({
      id: task.id,
      title: task.title,
      kind: task.kind,
      passCount: runs.filter((run) => run.pass).length,
      runCount: runs.length,
      passRate: runs.filter((run) => run.pass).length / runs.length,
      avg: summarizeRuns(runs),
      waste: aggregateWaste(runs),
      runs,
    });
  }

  const allRuns = results.flatMap((task) => task.runs);
  const summary = {
    taskCount: results.length,
    runCount: allRuns.length,
    passedRuns: allRuns.filter((run) => run.pass).length,
    passRate: allRuns.length ? allRuns.filter((run) => run.pass).length / allRuns.length : 0,
    avgDurationMs: average(allRuns.map((run) => run.durationMs)),
    avgModelRequests: average(allRuns.map((run) => run.modelRequests)),
    avgToolCalls: average(allRuns.map((run) => run.toolCalls)),
    avgInputTokens: average(allRuns.map((run) => run.inputTokens)),
    avgCacheHitTokens: average(allRuns.map((run) => run.cacheHitTokens)),
    avgOutputTokens: average(allRuns.map((run) => run.outputTokens)),
    avgFirstTokenMs: average(allRuns.map((run) => run.firstTokenMs)),
  };

  const wasteTotals = aggregateWaste(allRuns);

  const report = {
    schema: 1,
    meta: {
      cli: options.cli,
      model: options.model,
      provider: options.provider,
      suite: options.suite,
      repeat: options.repeat,
      startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
      cwd: process.cwd(),
    },
    summary,
    wasteTotals,
    tasks: results,
  };

  const file = writeReport(report);

  console.log('\n任务结果');
  printTable(
    results.map((task) => [
      task.id,
      `${task.passCount}/${task.runCount}`,
      formatSeconds(task.avg.avgDurationMs),
      formatCount(task.avg.avgModelRequests),
      formatCount(task.avg.avgToolCalls),
      formatTokens(task.avg.avgInputTokens),
      formatTokens(task.avg.avgCacheHitTokens),
      formatTokens(task.avg.avgOutputTokens),
      formatSeconds(task.avg.avgFirstTokenMs),
    ]),
    ['任务', '通过', '时长', '轮数', '工具', '输入tok', '缓存tok', '输出tok', '首字'],
  );

  console.log('\n汇总');
  printTable(
    [
      [
        '全部',
        `${summary.passedRuns}/${summary.runCount}`,
        `${(summary.passRate * 100).toFixed(0)}%`,
        formatSeconds(summary.avgDurationMs),
        formatCount(summary.avgModelRequests),
        formatCount(summary.avgToolCalls),
        formatTokens(summary.avgInputTokens),
        formatTokens(summary.avgCacheHitTokens),
        formatTokens(summary.avgOutputTokens),
        formatSeconds(summary.avgFirstTokenMs),
      ],
    ],
    ['范围', '通过', '通过率', '时长', '轮数', '工具', '输入tok', '缓存tok', '输出tok', '首字'],
  );

  console.log(`\n报告: ${path.relative(process.cwd(), file)}`);

  /* EVAL-02: 每次跑完自动出指标报告, 并跟上一次比 (只标涨跌, 不设门) */
  report.meta.reportPath = file;
  const previousFile = findPreviousReportFile(file);
  const previous = previousFile ? loadReportFile(previousFile) : null;
  console.log('');
  const markdown = renderMetricsReport(report, previous);
  const mdFile = file.replace(/\.json$/, '.md');
  fs.writeFileSync(mdFile, markdown);
  console.log(`\n指标报告: ${path.relative(process.cwd(), mdFile)}`);
  return report;
}

function loadReport(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`找不到报告: ${file}`);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function formatDelta(before, after, mode = 'plain') {
  if (typeof before !== 'number' || typeof after !== 'number') return '—';
  const diff = after - before;
  if (mode === 'percent') return `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(0)}pp`;
  if (mode === 'tokens') return `${diff >= 0 ? '+' : ''}${formatTokens(Math.abs(diff))}`;
  if (mode === 'seconds') return `${diff >= 0 ? '+' : '-'}${formatSeconds(Math.abs(diff))}`;
  return `${diff >= 0 ? '+' : ''}${Math.round(diff * 10) / 10}`;
}

function compareReports(fileA, fileB) {
  const a = loadReport(fileA);
  const b = loadReport(fileB);
  console.log(`对比  A=${path.basename(fileA)}  B=${path.basename(fileB)}`);
  console.log(`模型  A=${a.meta?.model ?? '?'}  B=${b.meta?.model ?? '?'}\n`);

  const byId = new Map();
  for (const task of a.tasks ?? []) byId.set(task.id, { a: task, b: null });
  for (const task of b.tasks ?? []) {
    if (byId.has(task.id)) byId.get(task.id).b = task;
    else byId.set(task.id, { a: null, b: task });
  }

  const rows = [...byId.entries()].map(([id, pair]) => {
    const aRate = pair.a ? pair.a.passRate : null;
    const bRate = pair.b ? pair.b.passRate : null;
    const delta = aRate !== null && bRate !== null ? bRate - aRate : null;
    return {
      id,
      aRate,
      bRate,
      delta,
      a: pair.a?.avg ?? {},
      b: pair.b?.avg ?? {},
    };
  });

  printTable(
    rows.map((row) => [
      row.id,
      row.aRate === null ? '—' : `${Math.round(row.aRate * 100)}%`,
      row.bRate === null ? '—' : `${Math.round(row.bRate * 100)}%`,
      row.delta === null ? '—' : formatDelta(row.aRate, row.bRate, 'percent'),
    ]),
    ['任务', 'A 通过率', 'B 通过率', '变化'],
  );

  const metricRows = [
    ['时长', 'avgDurationMs', 'seconds'],
    ['轮数', 'avgModelRequests', 'plain'],
    ['工具调用', 'avgToolCalls', 'plain'],
    ['输入 tok', 'avgInputTokens', 'tokens'],
    ['缓存 tok', 'avgCacheHitTokens', 'tokens'],
    ['输出 tok', 'avgOutputTokens', 'tokens'],
    ['首字 ms', 'avgFirstTokenMs', 'seconds'],
  ];

  const meanOf = (tasks, key) => {
    const values = (tasks ?? []).map((task) => task.avg?.[key]).filter((value) => typeof value === 'number');
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  console.log('\n指标均值 (按任务平均)');
  printTable(
    metricRows.map(([label, key, mode]) => {
      const before = meanOf(a.tasks, key);
      const after = meanOf(b.tasks, key);
      const show = (value) => (mode === 'seconds' ? formatSeconds(value) : mode === 'tokens' ? formatTokens(value) : formatCount(value));
      return [label, show(before), show(after), formatDelta(before, after, mode)];
    }),
    ['指标', 'A', 'B', '变化'],
  );

  const aRate = a.summary?.passRate;
  const bRate = b.summary?.passRate;
  if (typeof aRate === 'number' && typeof bRate === 'number') {
    console.log(`\n总通过率: A ${Math.round(aRate * 100)}% → B ${Math.round(bRate * 100)}% (${formatDelta(aRate, bRate, 'percent')})`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.compare) {
    const [fileA, fileB] = options.compare;
    if (!fileA || !fileB) throw new Error('--compare 需要两个报告文件');
    compareReports(fileA, fileB);
    return;
  }
  await runBench(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`✖ ${error?.message ?? error}`);
    process.exit(1);
  });
}
