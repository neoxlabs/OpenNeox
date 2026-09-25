#!/usr/bin/env node
/**
 * neox-evals CLI — 跑 benchmark harness 的入口.
 *
 *   neox-evals --version              打印版本
 *   neox-evals --help                 帮助
 *   neox-evals run-once               一次性 headless 跑 (调通 SDK 链路用, 不算 bench)
 *     --workspace <path>              agent 工作目录
 *     --prompt <string>               prompt
 *     --model <name>                  默认 claude-sonnet-4-6
 *     --provider <type>               anthropic | openai | kimi | ...
 *     --api-key <key>                 BYOK; 不传走 env (ANTHROPIC_API_KEY 等)
 *     --timeout-ms <ms>               默认 1800000 (30min)
 *
 *   后续 (E3+):
 *   neox-evals swebench               跑 SWE-bench (Verified / Lite / 单题)
 *
 *   设计: 子命令架构, commander 撑住. 一个子命令一个 file in src/runners/,
 *         CLI 文件本身只做 arg parsing + dispatch, 不写业务.
 */

import { Command } from 'commander';
import { runHeadlessAgent } from '../harness/headlessAgent.js';
import { runSweBench } from '../runners/swebench/runner.js';
import { summarizeOutcomes } from '../runners/swebench/grader.js';

const program = new Command();

program
  .name('neox-evals')
  .description('Neox Agent benchmark harness · SWE-bench / HumanEval / Browser-verify')
  .version('0.1.0');

program
  .command('run-once')
  .description('一次性 headless 跑 (链路 smoke test, 不算 benchmark)')
  .requiredOption('--workspace <path>', 'agent 工作目录 (cwd)')
  .requiredOption('--prompt <string>', 'agent prompt')
  .option('--model <name>', '模型名', 'claude-sonnet-4-6')
  .option('--provider <type>', 'provider 类型 (anthropic|openai|kimi|...)', 'anthropic')
  .option('--api-key <key>', 'BYOK API key; 不传走 env')
  .option('--base-url <url>', '(openai-compatible) base URL')
  .option('--timeout-ms <ms>', '超时 ms', '1800000')
  .action(async (opts) => {
    const apiKey = opts.apiKey || envKeyFor(opts.provider);
    if (!apiKey) {
      console.error(`[neox-evals] 缺 API key. 给 --api-key 或设 ${envKeyName(opts.provider)} 环境变量.`);
      process.exit(2);
    }

    console.log(`[neox-evals] run-once · model=${opts.model} provider=${opts.provider} workspace=${opts.workspace}`);
    console.log(`[neox-evals] prompt: ${opts.prompt.slice(0, 200)}${opts.prompt.length > 200 ? '...' : ''}`);
    console.log('---');

    const r = await runHeadlessAgent({
      workspace: opts.workspace,
      prompt: opts.prompt,
      model: opts.model,
      providerType: opts.provider,
      apiKey,
      baseURL: opts.baseUrl,
      timeoutMs: Number(opts.timeoutMs),
      onEvent: (ev) => {
        if (ev.type === 'tool_call_start') {
          process.stderr.write(`  · ${ev.name}\n`);
        }
      },
    });

    console.log('---');
    console.log(`[neox-evals] done · turns=${r.turns} stopReason=${r.stopReason} duration=${(r.durationMs / 1000).toFixed(1)}s`);
    console.log(`[neox-evals] usage · in=${r.usage.inputTokens} out=${r.usage.outputTokens}${r.usage.cacheReadTokens ? ` cache=${r.usage.cacheReadTokens}` : ''}`);
    if (r.errors.length) console.log(`[neox-evals] errors: ${r.errors.join(' | ')}`);
    console.log('---');
    console.log(r.finalText);
  });

program
  .command('swebench')
  .description('跑 SWE-bench Verified / Lite, 输出 predictions.json + outcomes.json')
  .option('--subset <name>', 'verified | verified-lite | lite | full', 'verified-lite')
  .option('--limit <n>', '只跑前 N 题 (debug 用)', (v) => parseInt(v, 10))
  .option('--instance-ids <ids>', '逗号分隔的 instance_id 列表 (单题复现用)')
  .option('--model <name>', '模型名', 'glm-4.6')
  .option('--provider <type>', 'provider 类型', 'openai')
  .option('--api-key <key>', 'BYOK; 不传走 env')
  .option('--base-url <url>', 'provider base URL')
  .option('--per-task-timeout-ms <ms>', '单题超时, 默认 1800000 (30min)', (v) => parseInt(v, 10))
  .option('--run-id <id>', 'run 标识 (出报表的目录名), 默认 timestamp')
  .option('--out-dir <dir>', '输出根目录, 默认 ./swebench-runs/<runId>/')
  .action(async (opts) => {
    const apiKey = opts.apiKey || envKeyFor(opts.provider);
    if (!apiKey) {
      console.error(`[neox-evals] 缺 API key. 给 --api-key 或设 ${envKeyName(opts.provider)} 环境变量.`);
      process.exit(2);
    }

    const result = await runSweBench({
      subset: opts.subset,
      limit: opts.limit,
      instanceIds: typeof opts.instanceIds === 'string' && opts.instanceIds.trim()
        ? opts.instanceIds.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined,
      model: opts.model,
      providerType: opts.provider,
      apiKey,
      baseURL: opts.baseUrl,
      perTaskTimeoutMs: opts.perTaskTimeoutMs,
      runId: opts.runId,
      outDir: opts.outDir,
    });

    console.log('');
    console.log(summarizeOutcomes(result.outcomes));
    console.log('');
    console.log(`predictions: ${result.predictionsPath}`);
    console.log(`outcomes:    ${result.outcomesPath}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('[neox-evals] fatal:', err?.message ?? err);
  process.exit(1);
});

function envKeyName(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'ANTHROPIC_API_KEY';
    case 'openai': case 'openai-responses': return 'OPENAI_API_KEY';
    case 'kimi': return 'KIMI_API_KEY';
    case 'glm': return 'GLM_API_KEY';
    case 'gemini': return 'GEMINI_API_KEY';
    case 'doubao': return 'DOUBAO_API_KEY';
    default: return 'NEOX_API_KEY';
  }
}
function envKeyFor(provider: string): string | undefined {
  return process.env[envKeyName(provider)];
}
