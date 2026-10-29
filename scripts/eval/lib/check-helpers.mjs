/**
 * 判分脚本的公共零件。
 *
 * 约定: 每个任务的 check.mjs 由 bench 用 `node check.mjs <workdir>` 调起, 退出码 0 = 通过。
 * 判分只看磁盘真相 (测试跑没跑过、文件里写了什么), 不看模型自己说做完了没有。
 */
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function workdirFromArgv() {
  const dir = process.argv[2];
  assert(dir && fs.existsSync(dir), '用法: node check.mjs <workdir>');
  return dir;
}

export function answerText() {
  const file = process.env.BENCH_OUTPUT_FILE;
  if (!file || !fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

/** 文件哈希 (给新任务用: 直接从仓库 fixture 算期望值, 不用手抄 64 位常量) */
export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 跑任意命令 (python / go / tsc 等), 返回 { code, out } */
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
    env: options.env ?? process.env,
  });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`, error: result.error ?? null };
}

export function assertCommandPass(command, args, options = {}, label = command) {
  const result = runCommand(command, args, options);
  assert(
    result.code === 0,
    `${label} 未通过 (exit=${result.code}${result.error ? `, ${result.error.message}` : ''})\n${tail(result.out, 2500)}`,
  );
  return result.out;
}

/** 测试文件钉死哈希: 改测试来“通过”不算通过 */
export function assertUntampered(workdir, relativePath, expectedSha256) {
  const file = path.join(workdir, relativePath);
  assert(fs.existsSync(file), `缺少受保护文件 ${relativePath}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert(actual === expectedSha256, `${relativePath} 被改动 (测试必须保持原样)`);
}

/** 跑 node --test, 返回退出码和输出 */
export function runNodeTest(workdir, files = [], extraArgs = []) {
  const args = ['--test', ...files, ...extraArgs];
  const result = spawnSync(process.execPath, args, {
    cwd: workdir,
    encoding: 'utf8',
    timeout: 300_000,
    env: process.env,
  });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

export function assertTestsPass(workdir, files = [], label = 'node --test') {
  const { code, out } = runNodeTest(workdir, files);
  assert(code === 0, `${label} 未通过 (exit=${code})\n${tail(out, 2500)}`);
  return out;
}

export function tail(text, limit = 1200) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `…${value.slice(-limit)}`;
}

export function readFileOrEmpty(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** 在 workdir 里按文件名找文件 (容忍大小写 / 子目录), 找不到返回 null */
export function findFile(workdir, matcher, options = {}) {
  const maxDepth = options.maxDepth ?? 3;
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'vendor']);
  const results = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (matcher(entry.name, full)) results.push(full);
    }
  };
  walk(workdir, 0);
  if (!results.length) return null;
  results.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return results[0];
}


/** 断言至少一条正则命中 —— 同一事实模型可能用不同措辞表达 */
export function assertAnyOf(text, patterns, label) {
  const value = String(text);
  assert(
    patterns.some((re) => re.test(value)),
    `${label} 未按要求出现 (试过的模式: ${patterns.map((re) => re.source).join(' | ')})`,
  );
}

/** 统一收尾: 打印 PASS/FAIL 并给出退出码 */
export function runCheck(fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      console.log('PASS');
      process.exit(0);
    })
    .catch((error) => {
      console.log(`FAIL: ${error?.message ?? error}`);
      process.exit(1);
    });
}
