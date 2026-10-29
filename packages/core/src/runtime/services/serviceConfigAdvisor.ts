
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listInstalledJdks, pickProjectJdkEnv } from './projectJdk.js';

export interface ServiceConfigDraft {
  configId?: string;
  lang?: 'zh' | 'en';
  name: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface ServiceConfigProposal {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  /** Spring 应用最终用的 profile 列表 —— 表单据此留在 Maven 结构里改 profile 字段, 不必退成 Shell 命令 */
  springProfiles?: string[];
  summary: string;
  changes: string[];
}

export type SideQuery = (messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<string>;

const MAX_LOG = 6000;

function read(file: string, max = 20000): string {
  try { return fs.readFileSync(file, 'utf-8').slice(0, max); } catch { return ''; }
}

/** stdout + stderr 都要: `java_home -V` / `java -version` 退出码 0 却只往 stderr 写 (只取 stdout 时 JDK 清单是空的) */
function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
}

/** 本机有哪些 JDK + 启动时会自动选哪个 (projectJdk 跟启动器同一套判断) */
function listJdks(workspaceRoot: string, cwdAbs: string): string {
  const out = listInstalledJdks().map((j) => `JDK ${j.major}${j.javafx ? ' (with JavaFX)' : ''}: ${j.home}`);
  if (process.env.JAVA_HOME) out.push(`JAVA_HOME=${process.env.JAVA_HOME}`);
  out.push(`default java -version: ${run('java', ['-version']).split('\n')[0] ?? ''}`);
  const auto = pickProjectJdkEnv(workspaceRoot, cwdAbs, process.env);
  out.push(auto ? `Launcher auto-selects JAVA_HOME=${auto.JAVA_HOME} when the config has no JAVA_HOME (matches declared version).`
    : 'Launcher keeps the default java (already matches the declared version, or no matching JDK installed).');
  return out.join('\n');
}

function projectFacts(workspaceRoot: string, cwdAbs: string): string {
  const facts: string[] = [`OS: ${process.platform}`, `workspace: ${workspaceRoot}`, `service cwd: ${cwdAbs}`];
  const rootPom = read(path.join(workspaceRoot, 'pom.xml'));
  if (rootPom) {
    const modules = [...rootPom.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]);
    if (modules.length) facts.push(`root pom.xml is a multi-module reactor: ${modules.join(', ')}`);
    const javaVer = rootPom.match(/<java\.version>([^<]+)</)?.[1] ?? rootPom.match(/<maven\.compiler\.source>([^<]+)</)?.[1];
    if (javaVer) facts.push(`declared Java version: ${javaVer}`);
  }
  const res = path.join(cwdAbs, 'src', 'main', 'resources');
  try {
    const profiles = fs.readdirSync(res).map((f) => f.match(/^application-([\w-]+)\.(ya?ml|properties)$/)?.[1]).filter(Boolean);
    if (profiles.length) facts.push(`Spring profiles available in ${path.relative(workspaceRoot, res)}: ${profiles.join(', ')}`);
    const active = read(path.join(res, 'application.yml'), 4000).match(/active:\s*([^\n#]+)/)?.[1];
    if (active) facts.push(`application.yml spring.profiles.active: ${active.trim()}`);
  } catch { /* 不是 Spring 模块 */ }
  const pkg = read(path.join(cwdAbs, 'package.json'));
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      facts.push(`package.json scripts: ${JSON.stringify(j.scripts ?? {})}`);
      if (j.engines) facts.push(`package.json engines: ${JSON.stringify(j.engines)}`);
    } catch { /* 坏 json */ }
    const nvmrc = read(path.join(cwdAbs, '.nvmrc'), 50).trim();
    if (nvmrc) facts.push(`.nvmrc: ${nvmrc}`);
    facts.push(`node -v: ${run('node', ['-v'])}`);
  }
  if (rootPom || read(path.join(cwdAbs, 'pom.xml'), 100)) facts.push(`Installed JDKs:\n${listJdks(workspaceRoot, cwdAbs)}`);
  facts.push(...genericFacts(workspaceRoot, cwdAbs));
  return facts.join('\n');
}

/** 两层目录树, 跳过依赖 / 产物目录 —— 入口在哪个子目录、有没有 venv / node_modules 一眼看清 */
function tree(dir: string, depth = 2, prefix = ''): string[] {
  const skip = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', '.idea', '.next', '.gradle', '.neox']);
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
  const out: string[] = [];
  for (const e of ents.slice(0, 40)) {
    if (e.name === '.DS_Store') continue;
    const mark = e.isDirectory() && skip.has(e.name) ? '/ (present, not listed)' : e.isDirectory() ? '/' : '';
    out.push(`${prefix}${e.name}${mark}`);
    if (e.isDirectory() && !skip.has(e.name) && depth > 1) out.push(...tree(path.join(dir, e.name), depth - 1, `${prefix}  `));
  }
  return out;
}

/** 跟语言无关的事实: 目录树、.env 样例、依赖清单、入口文件、README 里的运行步骤、本机已占用端口 */
function genericFacts(workspaceRoot: string, cwdAbs: string): string[] {
  const facts: string[] = [];
  const dir = fs.existsSync(cwdAbs) ? cwdAbs : workspaceRoot;
  facts.push(`Files under service cwd (2 levels):\n${tree(dir).slice(0, 120).join('\n')}`);
  for (const f of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env']) {
    const text = read(path.join(dir, f), 2000).trim();
    if (text) facts.push(`${f}:\n${text}`);
  }
  for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'go.mod', 'Cargo.toml', 'Procfile', 'Makefile', 'docker-compose.yml', 'manage.py']) {
    const text = read(path.join(dir, f), 1500).trim();
    if (text) facts.push(`${f}:\n${text}`);
  }
  if (read(path.join(dir, 'requirements.txt'), 10) || read(path.join(dir, 'pyproject.toml'), 10) || fs.existsSync(path.join(dir, 'manage.py'))) {
    facts.push(`python3 --version: ${run('python3', ['--version'])}`);
    facts.push(`virtualenv: ${['.venv', 'venv'].filter((v) => fs.existsSync(path.join(dir, v))).join(', ') || 'none'}`);
  }
  const pkgJson = read(path.join(dir, 'package.json'));
  if (pkgJson) {
    let deps = 0;
    try { const j = JSON.parse(pkgJson); deps = Object.keys({ ...j.dependencies, ...j.devDependencies }).length; } catch { /* 坏 json */ }
    /* 没声明依赖的工程缺 node_modules 是正常的, 说 MISSING 会把模型带偏 (端口冲突被判成没装依赖) */
    facts.push(`node_modules: ${deps === 0 ? 'not needed (no dependencies declared)' : fs.existsSync(path.join(dir, 'node_modules')) ? 'installed' : `MISSING (${deps} dependencies not installed)`}`);
    const lock = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb'].find((l) => fs.existsSync(path.join(dir, l)) || fs.existsSync(path.join(workspaceRoot, l)));
    if (lock) facts.push(`lockfile: ${lock}`);
  }
  if (read(path.join(dir, 'go.mod'), 10)) facts.push(`go version: ${run('go', ['version'])}`);
  const readme = read(path.join(dir, 'README.md'), 12000) || read(path.join(workspaceRoot, 'README.md'), 12000);
  const blocks = [...readme.matchAll(/```(?:bash|sh|shell|console)?\n([\s\S]*?)```/g)].map((m) => m[1].trim()).filter(Boolean);
  if (blocks.length) facts.push(`README command blocks:\n${blocks.join('\n---\n').slice(0, 1500)}`);
  if (process.platform !== 'win32') {
    const ports = [...new Set(run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']).split('\n').map((l) => l.match(/:(\d+) \(LISTEN\)/)?.[1]).filter(Boolean))];
    if (ports.length) facts.push(`TCP ports already in use on this machine: ${ports.slice(0, 60).join(', ')}`);
  }
  return facts;
}

function parseProposal(raw: string): ServiceConfigProposal | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.command !== 'string' || !j.command.trim()) return null;
    const env = j.env && typeof j.env === 'object'
      ? Object.fromEntries(Object.entries(j.env).filter(([k, v]) => k && typeof v === 'string')) as Record<string, string>
      : undefined;
    return {
      command: j.command.trim(),
      cwd: typeof j.cwd === 'string' && j.cwd.trim() ? j.cwd.trim() : '.',
      env: env && Object.keys(env).length ? env : undefined,
      springProfiles: Array.isArray(j.springProfiles) ? j.springProfiles.filter((p: unknown) => typeof p === 'string' && p) : undefined,
      summary: typeof j.summary === 'string' ? j.summary.trim() : '',
      changes: Array.isArray(j.changes) ? j.changes.filter((c: unknown) => typeof c === 'string').slice(0, 6) : [],
    };
  } catch { return null; }
}

export async function suggestServiceConfig(
  workspaceRoot: string,
  draft: ServiceConfigDraft,
  lastOutput: string,
  query: SideQuery,
  zh: boolean,
): Promise<{ ok: true; proposal: ServiceConfigProposal } | { ok: false; error: string }> {
  const cwdAbs = path.isAbsolute(draft.cwd) ? draft.cwd : path.resolve(workspaceRoot, draft.cwd || '.');
  /* 只给尾巴不够: Java 失败时尾巴全是堆栈和 BUILD FAILURE, 真正原因 (Could not resolve placeholder /
   * package does not exist) 在前面。先摘关键行 (去重), 再附尾巴 */
  const clean = lastOutput.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const keyLines = [...new Set(clean.split('\n').map((l) => l.trim().slice(0, 400))
    .filter((l) => /^Caused by:|\[ERROR\]|Exception:|does not exist|Could not|cannot find|not found|Error:|ERR!/i.test(l) && !/^\[ERROR\]\s*(\[Help|To see|Re-run|For more|After correcting|$)/.test(l)))];
  const key = keyLines.slice(-30).join('\n').slice(-MAX_LOG / 2);
  const log = (key ? `Key error lines:\n${key}\n\nTail:\n` : '') + clean.slice(-MAX_LOG / 2);
  const system = [
    'You fix local dev-service launch configs. Output ONLY one JSON object:',
    '{"command": string, "cwd": string (relative to workspace, "." for root), "env": {NAME: value} (optional),',
    ' "springProfiles": string[] (only for Spring Boot apps: the exact profiles your command passes),',
    ` "summary": one short sentence in ${zh ? 'Chinese' : 'English'} saying what you changed and why,`,
    ` "changes": up to 4 short bullet strings in ${zh ? 'Chinese' : 'English'}}.`,
    'Rules: keep the user\'s intent (same service, same profile unless the error proves it wrong).',
    'Multi-module Maven: from the reactor root, FIRST "mvn -q -pl <module> -am install -DskipTests", THEN "mvn -pl <module> spring-boot:run ..."',
    '  joined with "&&". Never put -am on the spring-boot:run step — it would run the goal in every library module and fail.',
    'Wrong JDK/Node: set JAVA_HOME / PATH in env to an installed version from the facts — never invent paths.',
    '  Pick the JDK matching the declared Java version (1.8 / 8 → a JDK 8 install). Compile errors on JDK-bundled packages',
    '  (javafx.*, com.sun.javafx.*, sun.*, javax.xml.bind, javax.annotation) mean the JDK is wrong, NOT a source bug:',
    '  javafx needs a JDK 8 that ships JavaFX (Oracle JDK 8 / Zulu FX). Never tell the user to edit source code.',
    'Spring: -Dspring-boot.run.profiles REPLACES spring.profiles.active. If application.yml activates e.g. "core, dev",',
    '  pass "core,dev" (keep the non-environment ones). "Could not resolve placeholder" usually means such a profile was dropped.',
    'The launcher already sets JAVA_HOME to the JDK matching the declared Java version (see facts) — do not override it unless the log proves otherwise.',
    'Dependencies not installed (node_modules MISSING, ModuleNotFoundError, "command not found" for a project tool):',
    '  prefix an idempotent install step, e.g. "npm install && npm run dev" (use the lockfile\'s package manager),',
    '  Python: "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/<tool> ..." (reuse an existing venv).',
    'Missing configuration (e.g. "X is required", "environment variable not set"): put values into env, taking them from .env.example /',
    '  .env.sample when present; otherwise use safe local-dev values (sqlite file, localhost). Never invent secrets for real services.',
    'Port already in use (EADDRINUSE / "Address already in use" / "Port 8080 was already in use"): move this service to a free port',
    '  (not in the in-use list) via the framework\'s own switch (PORT env, --port, --server.port=..., -Dserver.port).',
    'Wrong entry / directory ("no Go files", "could not determine which binary", relative-import errors, file not found):',
    '  point the command at the real entry seen in the file tree (go run ./cmd/x, cargo run --bin x, python -m pkg.mod, correct cwd).',
    'Follow README run instructions when they exist. Never use destructive commands (rm -rf, git reset/clean, dropping data).',
    'The command runs through the OS shell (cmd on Windows, sh elsewhere); "&&" is fine on both.',
    'If the current config already looks right and the log shows no launch error, return it unchanged and say so.',
  ].join('\n');
  const user = [
    `Service: ${draft.name}`,
    `Current command: ${draft.command}`,
    `Current cwd: ${draft.cwd}`,
    draft.env && Object.keys(draft.env).length ? `Current env: ${JSON.stringify(draft.env)}` : '',
    '',
    'Project facts:',
    projectFacts(workspaceRoot, cwdAbs),
    '',
    log.trim() ? `Last run output (tail):\n${log}` : 'No previous run output.',
  ].filter((l) => l !== undefined).join('\n');
  let raw = '';
  try {
    raw = await query([{ role: 'system', content: system }, { role: 'user', content: user }]);
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
  const proposal = parseProposal(raw);
  if (!proposal) return { ok: false, error: zh ? 'AI 没给出可用的配置, 再试一次' : 'AI returned no usable config, try again' };
  /* 启动器本来就会按工程选这个 JDK, 再写进配置只是噪音 (以后换机器路径还会失效) */
  const auto = pickProjectJdkEnv(workspaceRoot, cwdAbs, process.env);
  if (proposal.env?.JAVA_HOME && !draft.env?.JAVA_HOME && auto?.JAVA_HOME === proposal.env.JAVA_HOME) {
    const { JAVA_HOME: _drop, PATH: _path, ...rest } = proposal.env;
    proposal.env = Object.keys(rest).length ? rest : undefined;
  }
  return { ok: true, proposal };
}
