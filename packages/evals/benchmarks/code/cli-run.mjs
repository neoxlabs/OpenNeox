/**
 * 竞品 CLI 跑分器 —— 同一批任务 / 同一个模型 (DeepSeek 官方 deepseek-v4-flash) 下, 跑 opencode / Claude Code / Codex。
 *   跟 desktop-run.mjs (Neox) 同一套 tasks.mjs 的 setup / verify, 结果追加到 results/cli-runs.jsonl。
 *
 *   用法: DS_KEY_FILE=<600 权限的 key 文件> node cli-run.mjs [--tools opencode,claude,codex] [--tasks a,b] [--reps N] [--label L]
 *   key 只经 env 传给子进程, 不落日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SUITE = await import(argOf('--suite', '') === 'v2' ? './tasks-v2.mjs' : './tasks.mjs');
const { TASKS, ROOT } = SUITE;
const WORK = SUITE.WORK || path.join(ROOT, 'work');
const TOOLS = argOf('--tools', 'opencode,claude,codex').split(',');
const ONLY = argOf('--tasks', '') ? argOf('--tasks').split(',') : null;
const REPS = Number(argOf('--reps', '1'));
const LABEL = argOf('--label', 'H-cli');
const TIMEOUT_MS = Number(argOf('--timeout', String(8 * 60 * 1000)));
const KEY = fs.readFileSync(process.env.DS_KEY_FILE, 'utf8').trim();
const MODEL = 'deepseek-v4-flash';
const RES = path.join(ROOT, 'results');
fs.mkdirSync(path.join(RES, 'cli-raw'), { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const OPENCODE_CFG = path.join(RES, 'opencode-ds.json');
fs.writeFileSync(OPENCODE_CFG, JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  provider: { dsbench: { npm: '@ai-sdk/openai-compatible', name: 'DeepSeek bench',
    options: { baseURL: 'https://api.deepseek.com/v1', apiKey: '{env:DS_KEY}' },
    models: { [MODEL]: { name: MODEL } } } },
  permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' },
}, null, 1));

/** 每个工具: 命令行 + 从原始输出里抽 (回答 / 请求数 / 工具数 / token) */
const RUNNERS = {
  opencode: {
    cmd: (dir, prompt) => ['opencode', ['run', '-m', `dsbench/${MODEL}`, '--format', 'json', prompt]],
    env: { DS_KEY: KEY, OPENCODE_CONFIG: OPENCODE_CFG },
    parse(out) {
      const ev = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const texts = ev.filter((e) => e.type === 'text').map((e) => e.part?.text || e.text || '').join('\n');
      const steps = ev.filter((e) => e.type === 'step_start').length;
      const tools = ev.filter((e) => e.type === 'tool_use').length;
      let input = 0, cache = 0, output = 0;
      for (const e of ev.filter((x) => x.type === 'step_finish')) {
        const t = e.part?.tokens || e.tokens || {};
        input += (t.input || 0) + (t.cache?.read || 0); cache += t.cache?.read || 0; output += (t.output || 0) + (t.reasoning || 0);
      }
      return { answer: texts, requests: steps, tools, input, cache, output };
    },
  },
  claude: {
    cmd: (dir, prompt) => ['claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', MODEL]],
    env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    parse(out) {
      const ev = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const res = ev.find((e) => e.type === 'result') || {};
      /* 每条 assistant 消息 = 一次模型响应; 同一次响应可能拆成多条 (按 message.id 去重) */
      const ids = new Set(ev.filter((e) => e.type === 'assistant').map((e) => e.message?.id));
      const tools = ev.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content || []).filter((c) => c.type === 'tool_use').length;
      const u = res.usage || {};
      return { answer: String(res.result || ''), requests: ids.size || res.num_turns || 0, tools,
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), cache: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
    },
  },
  codex: {
    cmd: (dir, prompt) => ['codex', ['exec', '--ignore-user-config', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', '-C', dir,
      '-c', 'model_provider=dsbench', '-c', 'model_providers.dsbench.name="dsbench"', '-c', 'model_providers.dsbench.base_url="https://api.deepseek.com/v1"',
      '-c', 'model_providers.dsbench.env_key="DS_KEY"', '-c', 'model_providers.dsbench.wire_api="responses"', '-m', MODEL, prompt]],
    env: { DS_KEY: KEY },
    parse(out) {
      const ev = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const items = ev.filter((e) => e.type === 'item.completed').map((e) => e.item || {});
      const answer = items.filter((i) => i.type === 'agent_message').map((i) => i.text).join('\n');
      const tools = items.filter((i) => /command_execution|file_change|mcp_tool_call|web_search/.test(i.type)).length;
      let input = 0, cache = 0, output = 0;
      for (const e of ev.filter((x) => x.type === 'turn.completed')) { const u = e.usage || {}; input += u.input_tokens || 0; cache += u.cached_input_tokens || 0; output += (u.output_tokens || 0) + (u.reasoning_output_tokens || 0); }
      /* codex 的 JSON 流不报请求数; 近似 = 工具批次 + 1 (每批工具后一次响应) */
      return { answer, requests: null, tools, input, cache, output };
    },
  },
};

function runOnce(tool, task, rep) {
  const dir = path.join(WORK, `${task.id}__${tool}`);
  task.setup(dir);
  const r = RUNNERS[tool];
  const [bin, args] = r.cmd(dir, task.prompt);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const cp = spawn(bin, args, { cwd: dir, env: { ...process.env, ...r.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => { cp.kill('SIGTERM'); }, TIMEOUT_MS);
    cp.on('close', async (code) => {
      clearTimeout(kill);
      const wallMs = Date.now() - t0;
      const runId = `${task.id}__${tool}__r${rep}__${t0}`;
      fs.writeFileSync(path.join(RES, 'cli-raw', runId + '.out'), out);
      fs.writeFileSync(path.join(RES, 'cli-raw', runId + '.err'), err.replaceAll(KEY, '***'));
      let p = {};
      try { p = r.parse(out); } catch (e) { p = { answer: '', parseError: e.message }; }
      const v = await task.verify(dir, p.answer || '');
      const rec = { runId, label: LABEL, tool, model: MODEL, task: task.id, kind: task.kind, rep, ok: v.ok, why: v.why || null, exit: code, timedOut: wallMs >= TIMEOUT_MS, wallMs,
        requests: p.requests, tools: p.tools, input: p.input, cache: p.cache, output: p.output, answerTail: String(p.answer || '').replace(/\s+/g, ' ').slice(-160) };
      fs.appendFileSync(path.join(RES, 'cli-runs.jsonl'), JSON.stringify(rec) + '\n');
      resolve(rec);
    });
  });
}

const tasks = ONLY ? TASKS.filter((t) => ONLY.includes(t.id)) : TASKS;
for (let rep = 1; rep <= REPS; rep++) {
  for (const tool of TOOLS) {
    for (const task of tasks) {
      const r = await runOnce(tool, task, rep);
      log(`${r.ok ? '✓' : '✗'} ${tool.padEnd(9)} ${task.id.padEnd(14)} r${rep} ${(r.wallMs / 1000).toFixed(1)}s 请求${r.requests ?? '-'} 工具${r.tools} in ${r.input} out ${r.output} ${r.why || ''}${r.timedOut ? ' [超时]' : ''}`);
    }
  }
}
