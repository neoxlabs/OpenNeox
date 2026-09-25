/**
 * SWE-bench grader.
 *
 *   两档:
 *     1. **local quick grader** (本文件): 仅看 patch 形态 ─ 非空 / 解析合法 / touch 了文件.
 *        给 pilot 用, 立刻知道"agent 至少改了东西 vs 完全没产出".
 *         不算分, 不能跟 Cursor/Devin 数字比.
 *
 *     2. **official harness** (run-official-grader.md 文档): 把 predictions.json 喂给
 *        princeton-nlp/SWE-bench 官方 Python harness, 真在 docker 跑 FAIL_TO_PASS + PASS_TO_PASS.
 *         唯一可对外发布的分数来源.
 *        命令:  pip install swebench && python -m swebench.harness.run_evaluation \
 *                 --predictions_path <preds.json> --dataset_name princeton-nlp/SWE-bench_Verified \
 *                 --max_workers 4 --run_id <run-id>
 *
 *   predictions JSON 格式 (官方定义):
 *     [
 *       { "instance_id": "astropy__astropy-12907",
 *         "model_name_or_path": "neox-glm-4.6",
 *         "model_patch": "diff --git a/... ..." },
 *       ...
 *]
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SweBenchTask } from './types.js';

export interface Prediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export interface LocalGradeOutcome {
  instance_id: string;
  /** 'produced_patch' = 有非空 diff (touched 文件); 'empty_patch' = agent 啥也没改; 'error' = agent 跑挂 */
  status: 'produced_patch' | 'empty_patch' | 'error';
  /** patch touch 的文件数 — 0 表示 empty */
  files_touched: number;
  /** 总 + 行数 (粗略改动量) */
  lines_added: number;
  /** 总 - 行数 */
  lines_removed: number;
  /** agent 跑的 wallclock 毫秒 */
  duration_ms?: number;
  /** agent 一共调了几个工具 (粗略复杂度) */
  agent_turns?: number;
  /** stop reason — end_turn / failed / timeout / abort */
  stop_reason?: string;
  /** 错误信息 (status='error' 时) */
  error?: string;
}

/** 浅解析 unified diff, 数 files_touched + lines_added/removed. 不验证语法正确性, 只是数行. */
export function gradeLocally(task: SweBenchTask, patch: string, meta: {
  duration_ms?: number; agent_turns?: number; stop_reason?: string; error?: string;
}): LocalGradeOutcome {
  if (meta.error) {
    return {
      instance_id: task.instance_id,
      status: 'error',
      files_touched: 0,
      lines_added: 0,
      lines_removed: 0,
      ...meta,
    };
  }
  const trimmed = (patch || '').trim();
  if (!trimmed) {
    return {
      instance_id: task.instance_id,
      status: 'empty_patch',
      files_touched: 0,
      lines_added: 0,
      lines_removed: 0,
      ...meta,
    };
  }
  let files = 0, added = 0, removed = 0;
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('diff --git ')) files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return {
    instance_id: task.instance_id,
    status: 'produced_patch',
    files_touched: files,
    lines_added: added,
    lines_removed: removed,
    ...meta,
  };
}

export async function writePredictionsJson(
  preds: Prediction[],
  outPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(preds, null, 2), 'utf-8');
}

export async function writeOutcomesJson(
  outcomes: LocalGradeOutcome[],
  outPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(outcomes, null, 2), 'utf-8');
}

/** 给 stdout 一个简短可读 summary —— pilot 主要靠它看 "整体形态" */
export function summarizeOutcomes(outcomes: LocalGradeOutcome[]): string {
  const total = outcomes.length;
  const produced = outcomes.filter(o => o.status === 'produced_patch').length;
  const empty    = outcomes.filter(o => o.status === 'empty_patch').length;
  const errored  = outcomes.filter(o => o.status === 'error').length;
  const lines: string[] = [];
  lines.push(`Summary · ${total} task(s):`);
  lines.push(`  produced_patch: ${produced}  (${((produced/total)*100).toFixed(0)}%)`);
  lines.push(`  empty_patch:    ${empty}`);
  lines.push(`  error:          ${errored}`);
  lines.push('');
  lines.push('per-task:');
  for (const o of outcomes) {
    const tag = o.status === 'produced_patch' ? '✅'
              : o.status === 'empty_patch'    ? '⚠️ '
              :                                 '❌';
    const stats = o.status === 'produced_patch'
      ? `${o.files_touched}f +${o.lines_added}/-${o.lines_removed}`
      : (o.error?.slice(0, 60) ?? o.stop_reason ?? '');
    const dur = o.duration_ms ? `${(o.duration_ms/1000).toFixed(1)}s` : '?';
    const turns = o.agent_turns ?? '?';
    lines.push(`  ${tag} ${o.instance_id.padEnd(36)} ${stats}  ${turns}t ${dur}`);
  }
  lines.push('');
  lines.push('Next: run official grader for real PASS/FAIL scoring:');
  lines.push('  pip install swebench');
  lines.push('  python -m swebench.harness.run_evaluation \\');
  lines.push('    --dataset_name princeton-nlp/SWE-bench_Verified \\');
  lines.push('    --predictions_path <preds.json> --max_workers 4 --run_id <id>');
  return lines.join('\n');
}
