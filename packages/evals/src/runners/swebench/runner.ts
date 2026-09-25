/**
 * SWE-bench runner — 把 load / prepare / agent / patch / grader 串成一个 loop.
 *
 *   单任务流程:
 *     1. prepareTaskWorkspace          worktree 拉到 base_commit
 *     2. buildPromptFromTask           把 problem_statement + hints 拼成 agent 输入
 *     3. runHeadlessAgent              工作区跑 agent → 修文件
 *     4. extractTaskPatch              git diff HEAD → patch 字符串
 *     5. gradeLocally                  浅评 (有/没/出错)
 *     6. cleanupTaskWorkspace          删 worktree
 *     7. 累计 predictions[] + outcomes[]
 *
 *   一次 batch 跑完写两个文件:
 *     · predictions.json    给官方 Python harness 用 (instance_id + model_patch)
 *     · outcomes.json       给我们自己看 (含 status / 时长 / token / 错误)
 *
 *   失败任务 (agent 抛错 / 超时 / 网络挂) 不会 abort batch — 单题 catch, outcome 标 'error',
 *   batch 继续往下. SWE-bench 跑长时间, 单题崩不能拖死全场.
 */

import * as path from 'path';
import { loadSweBenchTasks } from './dataset.js';
import type { SweBenchSubset, SweBenchTask } from './types.js';
import { prepareTaskWorkspace, extractTaskPatch, cleanupTaskWorkspace } from './workspace.js';
import {
  gradeLocally,
  writePredictionsJson,
  writeOutcomesJson,
  summarizeOutcomes,
  type Prediction,
  type LocalGradeOutcome,
} from './grader.js';
import { runHeadlessAgent, type HeadlessProviderType } from '../../harness/headlessAgent.js';

export interface SweBenchRunnerOptions {
  /** 数据集子集 */
  subset?: SweBenchSubset;
  /** 只跑前 N 题 */
  limit?: number;
  /** 只跑指定 instance_id */
  instanceIds?: string[];
  /** 模型 */
  model: string;
  /** provider */
  providerType: HeadlessProviderType;
  apiKey: string;
  baseURL?: string;
  /** 单题超时 ms, 默认 30 min */
  perTaskTimeoutMs?: number;
  /** run id — 用于工作区 + 报表命名, 默认 timestamp */
  runId?: string;
  /** 输出根目录 — 默认 ./swebench-runs/<runId>/ */
  outDir?: string;
  /** 进度回调 (用于 CLI 打 progress) */
  onProgress?: (info: { idx: number; total: number; task: SweBenchTask; outcome: LocalGradeOutcome }) => void;
}

export interface SweBenchRunResult {
  runId: string;
  outDir: string;
  predictionsPath: string;
  outcomesPath: string;
  outcomes: LocalGradeOutcome[];
  predictions: Prediction[];
}

function buildPromptFromTask(task: SweBenchTask): string {
  /* 标准 SWE-bench prompt: 给 issue 正文 + hints + 期望. 不揭示 gold patch / test_patch (会泄题).
   * "verify by running tests" 是为了驱动 agent 真跑 pytest, 不只是改文件就 yield. */
  const sections: string[] = [];
  sections.push(`<issue>`);
  sections.push(task.problem_statement.trim());
  sections.push(`</issue>`);
  if (task.hints_text?.trim()) {
    sections.push('');
    sections.push(`<maintainer-hints>`);
    sections.push(task.hints_text.trim());
    sections.push(`</maintainer-hints>`);
  }
  sections.push('');
  sections.push([
    `You are working in a checkout of ${task.repo} at commit ${task.base_commit}.`,
    `Read the issue above carefully, find the bug in the codebase, and write a patch that fixes it.`,
    ``,
    `Constraints:`,
    `  - Only modify source files (NOT tests). The grader will apply hidden tests separately.`,
    `  - Keep the change minimal and targeted at the bug; don't refactor unrelated code.`,
    `  - Before yielding, run the project's test suite (or at least a relevant subset) to verify your fix doesn't break anything.`,
    `  - Use the project's own conventions (style, imports, error handling).`,
    `  - Yield when you believe the fix is complete and verified.`,
  ].join('\n'));
  return sections.join('\n');
}

export async function runSweBench(options: SweBenchRunnerOptions): Promise<SweBenchRunResult> {
  const runId = options.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = options.outDir ?? path.join(process.cwd(), 'swebench-runs', runId);
  const perTaskTimeoutMs = options.perTaskTimeoutMs ?? 30 * 60 * 1000;
  const modelLabel = `neox-${options.providerType}-${options.model}`;

  const tasks = await loadSweBenchTasks({
    subset: options.subset,
    limit: options.limit,
    instanceIds: options.instanceIds,
  });
  process.stderr.write(`[swebench-runner] loaded ${tasks.length} task(s), runId=${runId}\n`);

  const predictions: Prediction[] = [];
  const outcomes: LocalGradeOutcome[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    process.stderr.write(`\n[swebench-runner] [${i + 1}/${tasks.length}] ${task.instance_id}\n`);

    let layout: Awaited<ReturnType<typeof prepareTaskWorkspace>> | null = null;
    let patch = '';
    let outcome: LocalGradeOutcome;
    try {
      layout = await prepareTaskWorkspace(task, { runId });
      const prompt = buildPromptFromTask(task);
      const agentRes = await runHeadlessAgent({
        workspace: layout.workDir,
        prompt,
        model: options.model,
        providerType: options.providerType,
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        timeoutMs: perTaskTimeoutMs,
        onEvent: (ev) => {
          if (ev.type === 'tool_call_start') {
            process.stderr.write(`  · ${ev.name}\n`);
          }
        },
      });
      patch = await extractTaskPatch(layout);
      outcome = gradeLocally(task, patch, {
        duration_ms: agentRes.durationMs,
        agent_turns: agentRes.turns,
        stop_reason: agentRes.stopReason,
      });
    } catch (err: any) {
      outcome = gradeLocally(task, '', {
        error: err?.message ?? String(err),
      });
      process.stderr.write(`  ❌ ${outcome.error}\n`);
    } finally {
      if (layout) {
        await cleanupTaskWorkspace(layout).catch(() => undefined);
      }
    }

    predictions.push({
      instance_id: task.instance_id,
      model_name_or_path: modelLabel,
      model_patch: patch,
    });
    outcomes.push(outcome);
    options.onProgress?.({ idx: i, total: tasks.length, task, outcome });
  }

  const predictionsPath = path.join(outDir, 'predictions.json');
  const outcomesPath = path.join(outDir, 'outcomes.json');
  await writePredictionsJson(predictions, predictionsPath);
  await writeOutcomesJson(outcomes, outcomesPath);

  process.stderr.write(`\n[swebench-runner] wrote ${predictions.length} prediction(s) → ${predictionsPath}\n`);
  process.stderr.write(`[swebench-runner] wrote ${outcomes.length} outcome(s) → ${outcomesPath}\n`);

  return { runId, outDir, predictionsPath, outcomesPath, outcomes, predictions };
}
