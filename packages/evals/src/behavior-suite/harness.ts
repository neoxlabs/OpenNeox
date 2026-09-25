/**
 * behavior-suite/harness — 行为考场共享基元.
 *
 *   跟 release-suite 的 cli-tests 同一世界观: spawn 真 CLI (`tsx main.ts -p`) +
 *   可编程断言. 区别是每个任务自带一个 *带陷阱的 fixture 临时 git 仓库*,
 *   断言主要看 *文件系统/git 的客观痕迹* (改了哪个文件 / diff 多大 / 测试跑没跑),
 *   不依赖 LLM 输出格式 (输出只做宽 regex 辅助).
 *
 *   设计原则 (对齐 release-suite):
 *     · 断言内聚在 fixture 的 assert.ts — "什么算对" 跟任务强耦合, 不抽公共评估框架.
 *     · 痕迹优先: 比如 "有没有跑测试" 不解析 tool-trace, 而是让 fixture 的
 *       run-tests.js 落 .eval/test-runs.log — 文件系统就是 tool-trace.
 */

import { execa } from 'execa';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _dirname = dirname(fileURLToPath(import.meta.url));
/* packages/evals/src/behavior-suite → repo root = ../../../../ */
export const REPO_ROOT = join(_dirname, '..', '..', '..', '..');
export const FIXTURES_DIR = join(_dirname, 'fixtures');

/** 断言里跑 tsc 用仓库自带的 typescript (fixture 不装依赖). */
export const TSC_BIN = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
export const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
export const CLI_MAIN = join(REPO_ROOT, 'apps', 'cli', 'src', 'main.ts');

/* ============================================================
 * 类型
 * ============================================================ */

/** 一次 agent run 的原始产物 (assert 的输入). */
export interface AgentRunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface AssertCtx extends AgentRunOutcome {
  /** fixture 实例化出来的临时 git 仓库 (agent 的 cwd) */
  workDir: string;
}

/** 单条断言 — name 固定, pass 硬判, detail 给报告 reviewer 看. */
export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
  /** optional=true 的 check 不参与 pass 判定 (只记录, 比如 judge 分) */
  optional?: boolean;
}

export interface AssertResult {
  pass: boolean;
  checks: CheckResult[];
}

/** fixture 模块契约 — 每个 fixtures/<task-id>/ 提供 setup.ts + assert.ts + task.md. */
export interface FixtureModule {
  setup: (workDir: string) => Promise<void>;
  assert: (ctx: AssertCtx) => Promise<AssertResult>;
  /** 可选: setup.ts 导出 `export const env = {...}` — 跑 CLI 时注入 (用途模式等) */
  env?: Record<string, string>;
}

/* ============================================================
 * 断言小工具
 * ============================================================ */

export function check(name: string, pass: boolean, detail?: string, optional?: boolean): CheckResult {
  return { name, pass, detail, optional };
}

/** 汇总 checks → AssertResult (optional 不参与判定). */
export function finalize(checks: CheckResult[]): AssertResult {
  return { pass: checks.filter((c) => !c.optional).every((c) => c.pass), checks };
}

/** 跑一条 shell (在 fixture 目录里), 不抛错 — 断言自己看 exitCode. */
export async function sh(
  cmd: string,
  cwd: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const r = await execa(cmd, { shell: true, cwd, reject: false, timeout: opts.timeoutMs ?? 60_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? -1 };
}

/** node -e 一段脚本 (在 fixture 目录里), 用于行为验证. */
export async function runNode(
  script: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const r = await execa(process.execPath, ['-e', script], { cwd, reject: false, timeout: 30_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? -1 };
}

/* ============================================================
 * git 痕迹
 * ============================================================ */

/** setup 末尾调用: 把 fixture 初始状态钉进 git (后续断言全靠 diff 这个基线). */
export async function initGitRepo(dir: string): Promise<void> {
  const r = await sh(
    'git init -q && git add -A && git -c user.name=neox-eval -c user.email=eval@neox.local commit -qm fixture-init',
    dir,
  );
  if (r.exitCode !== 0) throw new Error(`initGitRepo failed: ${r.stderr}`);
}

/** 改动过的文件 (staged/unstaged/untracked 全算) — 路径相对 workDir. */
export async function gitChangedFiles(dir: string): Promise<string[]> {
  const r = await sh('git status --porcelain', dir);
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[A-Z?! ]+\s+/, '').replace(/^"|"$/g, ''));
}

/** 工作区是否跟 fixture-init 完全一致 (无修改无新文件). */
export async function gitIsClean(dir: string): Promise<{ clean: boolean; dirt: string }> {
  const r = await sh('git status --porcelain', dir);
  const dirt = r.stdout.trim();
  return { clean: dirt.length === 0, dirt };
}

/** tracked 文件 diff 的总行数 (added+deleted) — minimal-change 的阈值断言用. */
export async function gitDiffTotalLines(dir: string): Promise<number> {
  const r = await sh('git add -N . && git diff --numstat HEAD', dir);
  let total = 0;
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (m) total += (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]));
  }
  return total;
}

/** 某文件相对 fixture-init 的 diff 文本 (含新增文件). */
export async function gitDiffOf(dir: string, file: string): Promise<string> {
  const r = await sh(`git add -N . && git diff HEAD -- "${file}"`, dir);
  return r.stdout;
}

/* ============================================================
 * agent 驱动
 * ============================================================ */

export interface DriveOpts {
  provider: string;
  model: string;
  timeoutMs: number;
  /** fixture 级环境变量 (如 NEOX_AGENT_MODE=assistant 驱动用途模式) — merge 进 CLI env */
  env?: Record<string, string>;
}

/** 在 workDir 里跑一次 `neox -p <task>` (真 LLM, dev 入口 tsx main.ts). */
export async function driveAgent(workDir: string, prompt: string, opts: DriveOpts): Promise<AgentRunOutcome> {
  const t0 = Date.now();
  const r = await execa(
    TSX_BIN,
    [CLI_MAIN, '-p', prompt, '--provider', opts.provider, '-m', opts.model],
    {
      cwd: workDir,
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? '/etc/ssl/cert.pem',
        NEOX_NON_INTERACTIVE: '1',
        ...(opts.env ?? {}),
      },
      reject: false,
      timeout: opts.timeoutMs,
      stripFinalNewline: false,
    },
  );
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.exitCode ?? null,
    durationMs: Date.now() - t0,
    timedOut: r.timedOut === true,
  };
}

/** fixture 的 task.md → prompt 文本. */
export function loadTaskPrompt(taskId: string): string {
  const p = join(FIXTURES_DIR, taskId, 'task.md');
  if (!existsSync(p)) throw new Error(`fixture ${taskId} 缺 task.md`);
  return readFileSync(p, 'utf-8').trim();
}

/** 建一个隔离临时目录当 fixture 实例. */
export function makeWorkDir(taskId: string): string {
  return mkdtempSync(join(tmpdir(), `neox-behavior-${taskId}-`));
}
