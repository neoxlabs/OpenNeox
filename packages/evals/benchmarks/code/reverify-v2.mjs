import fs from 'node:fs';
import path from 'node:path';
import { TASKS, ROOT, WORK } from './tasks-v2.mjs';

const RES = path.join(ROOT, 'results');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const NL = argOf('--neox', 'V2-neox');
const CL = argOf('--cli', 'V2-cli');
const ONLY = argOf('--task', '');
const WDIR = argOf('--work', WORK);
const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

function cliAnswer(tool, runId) {
  const ev = rd(path.join(RES, 'cli-raw', runId + '.out'));
  if (tool === 'opencode') return ev.filter((e) => e.type === 'text').map((e) => e.part?.text || '').join('\n');
  if (tool === 'claude') return String(ev.find((e) => e.type === 'result')?.result || '');
  if (tool === 'codex') return ev.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text).join('\n');
  return '';
}

const jobs = [
  ...rd(path.join(RES, 'desktop-runs.jsonl')).filter((r) => r.label === NL).map((r) => ({
    tool: 'neox', task: r.task, dir: path.join(WDIR, r.task), was: r.ok,
    /* ask_user 在事件里, 不在回答正文 —— 补上标记, 模糊类任务才认得出"先澄清" */
    answer: (r.answerTail || '') + (rd(path.join(RES, 'events', r.runId + '.jsonl'))
      .some((e) => e.type === 'tool_call_start' && e.data?.name === 'ask_user') ? '\n[ASKED_USER]' : ''),
  })),
  ...rd(path.join(RES, 'cli-runs.jsonl')).filter((r) => r.label === CL).map((r) => ({ tool: r.tool, task: r.task, dir: path.join(WDIR, `${r.task}__${r.tool}`), answer: cliAnswer(r.tool, r.runId), was: r.ok })),
].filter((j) => !ONLY || j.task === ONLY);

const out = [];
for (const j of jobs) {
  const t = TASKS.find((x) => x.id === j.task);
  if (!t || !fs.existsSync(j.dir)) continue;
  const v = await t.verify(j.dir, j.answer);
  out.push({ ...j, ok: v.ok, why: v.why || null, extra: v.extra || null, answer: undefined, dir: undefined });
  console.log(`${v.ok ? '✓' : '✗'} ${j.tool.padEnd(9)} ${j.task.padEnd(14)} ${j.was !== v.ok ? `(原判 ${j.was ? '✓' : '✗'}) ` : ''}${v.why || ''}`.slice(0, 220));
}
fs.writeFileSync(path.join(RES, 'v2-reverify.jsonl'), out.map((x) => JSON.stringify(x)).join('\n') + '\n');
