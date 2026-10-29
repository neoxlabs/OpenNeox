#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 日志里出现这些字样就说明 bun 打包漏了模块 —— 一律拒绝发版 */
export const FATAL_LOG_PATTERNS = [
  /Cannot find module/,
  /Cannot find package/,
  /Dynamic require of .* is not supported/,
];

export function parseArgs(argv) {
  const get = (k, fallback = undefined) => {
    const eq = `${k}=`;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === k && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
      if (argv[i].startsWith(eq)) return argv[i].slice(eq.length);
    }
    return fallback;
  };
  return {
    bin: get('--bin'),
    home: get('--home'),
    prompt: get('--prompt', 'neox cli smoke test'),
    keepHome: argv.includes('--keep-home'),
  };
}

/** 从若干段文本里找出命中的致命行 (带来源标签), 纯函数便于单测 */
export function scanForMissingModules(texts) {
  const hits = [];
  for (const { source, text } of texts) {
    if (!text) continue;
    for (const line of String(text).split('\n')) {
      if (FATAL_LOG_PATTERNS.some((re) => re.test(line))) {
        hits.push({ source, line: line.trim() });
      }
    }
  }
  return hits;
}

/** 收集隔离 HOME 下所有 .neox 开头的家目录里的 logs 日志 (worktree / vscode 插件会用别的家目录名) */
export function collectLogTexts(homeDir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(homeDir); } catch { return out; }
  for (const name of names) {
    if (!name.startsWith('.neox')) continue;
    const logsDir = path.join(homeDir, name, 'logs');
    let logNames = [];
    try { logNames = fs.readdirSync(logsDir); } catch { continue; }
    for (const logName of logNames) {
      const p = path.join(logsDir, logName);
      try {
        if (fs.statSync(p).isFile()) out.push({ source: p, text: fs.readFileSync(p, 'utf8') });
      } catch { /* 并发写 / 权限 —— 冒烟不因读日志失败 */ }
    }
  }
  return out;
}

function run(bin, args, env) {
  return spawnSync(bin, args, { env, encoding: 'utf8', timeout: 120_000 });
}

export function main(argv = process.argv.slice(2)) {
  const { bin, home, prompt, keepHome } = parseArgs(argv);
  if (!bin) {
    console.error('用法: node scripts/check-cli-binary-smoke.mjs --bin <path> [--home <dir>] [--prompt <text>]');
    return 2;
  }
  if (!fs.existsSync(bin)) {
    console.error(`❌ 二进制不存在: ${bin}`);
    return 1;
  }

  const homeDir = home || fs.mkdtempSync(path.join(os.tmpdir(), 'neox-cli-smoke-'));
  fs.mkdirSync(homeDir, { recursive: true });
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLI_DEBUG: '1',
    NO_COLOR: '1',
  };
  /* 冒烟不该继承开发者自己的库 / 配置路径 */
  delete env.NEOX_DB_PATH;
  delete env.NEOX_HOME_DIRNAME;

  const texts = [];
  let failed = false;

  const versionRun = run(bin, ['--version'], env);
  const versionOut = `${versionRun.stdout || ''}${versionRun.stderr || ''}`.trim();
  console.log(`── --version (exit=${versionRun.status}) ──`);
  console.log(versionOut || '(无输出)');
  if (versionRun.status !== 0 || !/\d+\.\d+\.\d+/.test(versionOut)) {
    console.error('❌ 二进制 --version 跑不起来 / 没打印版本号');
    failed = true;
  }
  texts.push({ source: '--version', text: versionOut });

  const printRun = run(bin, ['-p', prompt], env);
  const printOut = `${printRun.stdout || ''}${printRun.stderr || ''}`;
  console.log(`── -p (exit=${printRun.status}) ──`);
  console.log(printOut.trim().slice(-2000) || '(无输出)');
  /* 未登录 / 无凭据导致非零退出是正常的 —— 冒烟只关心模块解析 */
  texts.push({ source: '-p', text: printOut });
  texts.push(...collectLogTexts(homeDir));

  /* 第二阶段: 故意让 DB 打不开, 逼出 routingState.getDb() 的兜底分支。
   * 事故里那条 "Cannot find module './database.js' from '/$bunfs/root/neox'" 就是从这里发出的 ——
   * 正常 HOME 下 db 初始化成功, 走不到兜底, 闸会漏。用只读父目录让 getDatabase() 抛错
   * (POSIX 有效; Windows 上 chmod 不拦写, 这一阶段自然不触发, 不会误报)。
   * 用 --provider neox-cloud -m 让 provider 解析真的去读 routing, 否则提前 "No default model" 退出。 */
  const roDir = path.join(homeDir, 'readonly-db');
  fs.mkdirSync(roDir, { recursive: true });
  let fallbackOut = '';
  try {
    fs.chmodSync(roDir, 0o500);
    const fallbackRun = run(
      bin,
      ['-p', prompt, '--provider', 'neox-cloud', '-m', 'deepseek-v4.1-flash-1017'],
      { ...env, NEOX_DB_PATH: path.join(roDir, 'neox.db') },
    );
    fallbackOut = `${fallbackRun.stdout || ''}${fallbackRun.stderr || ''}`;
    console.log(`── -p (db 不可用, 走 getDb 兜底; exit=${fallbackRun.status}) ──`);
    console.log(fallbackOut.trim().slice(-1000) || '(无输出)');
    texts.push({ source: '-p (db 不可用)', text: fallbackOut });
    texts.push(...collectLogTexts(homeDir));
    if (!texts.some((t) => /getDb\(\) failed/.test(t.text || ''))) {
      console.log('ℹ️ 未逼出 getDb 兜底分支 (该平台 chmod 不拦写?) — 这一阶段未覆盖');
    }
  } finally {
    try { fs.chmodSync(roDir, 0o700); } catch { /* 清理失败不影响结论 */ }
  }

  const hits = scanForMissingModules(texts);
  if (hits.length > 0) {
    console.error('\n❌ 日志里出现模块解析失败 —— bun --compile 打包漏了模块, 拒绝发版:');
    for (const h of hits.slice(0, 20)) console.error(`   [${h.source}] ${h.line}`);
    failed = true;
  }

  if (!keepHome && !home) {
    fs.rmSync(homeDir, { recursive: true, force: true });
  } else {
    console.log(`ℹ️ 冒烟 HOME 保留在 ${homeDir}`);
  }

  if (failed) return 1;
  console.log('✅ CLI 二进制冒烟通过 — --version / -p 均可运行, 日志无 Cannot find module');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main());
}
