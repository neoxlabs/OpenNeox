/**
 * 判分自测: 正确报告换几种说法要判过, 漏项 / 数字错的要判不过。
 *
 * 用法: node --test scripts/eval/tasks/work-report-release/check.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CHECK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check.mjs');

function runCheck(report) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-report-release-'));
  try {
    fs.writeFileSync(path.join(workdir, 'REPORT.md'), report);
    const result = spawnSync(process.execPath, [CHECK, workdir], { encoding: 'utf8' });
    return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

const reportA = `## 版本
2.1.0，含 1 个破坏性变更：run() 改为返回 Promise。

## 修复
- slug 的连续空格与重音字符处理修正。
- 重试逻辑不再对 4xx 发起请求。
- xlsx 导出合计行的公式引用错行已修正。

## 风险
p95 从 240ms 降到 180ms；INC-2041 的根因是连接池耗尽。

## 下一步
补 12 个回归测试，覆盖连接释放路径。
`;

const reportB = `## 版本
本次发布 2.1.0。有 1 个破坏性变更：run() 返回 Promise。

## 修复
1. slugify 对连续空白字符处理不正确
2. 遇到 400/404 这类客户端错误时不再重试
3. Excel 合计行公式引用了错误的行

## 风险
p95 由 240ms 降至 180ms；事故 INC-2041 源于连接池耗尽。

## 下一步
补十二项回归测试，验证连接释放；顺带写迁移说明。
`;

const reportC = `## 版本
2.1.0（1 个破坏性变更：run() 返回 Promise）。

## 修复
- slug：连续空格、重音字符
- 重试：4xx 不再无意义重试
- xlsx：合计行公式引用错行

## 风险
p95 240ms → 180ms；INC-2041 根因连接池耗尽。

## 下一步
下周补 12 个回归测试。
`;

test('正确报告: 按条目列出三项修复 (不写「3 个」) 判过', () => {
  const { code, out } = runCheck(reportA);
  assert.equal(code, 0, out);
});

test('正确报告: 同义写法 (空白字符 / 400 404 / Excel) + 「十二」判过', () => {
  const { code, out } = runCheck(reportB);
  assert.equal(code, 0, out);
});

test('正确报告: 极简条目式 + 数字 12 与「回归测试」相隔较远判过', () => {
  const { code, out } = runCheck(reportC);
  assert.equal(code, 0, out);
});

test('漏掉一项修复 (4xx 重试) 判不过', () => {
  const report = reportA.replace('- 重试逻辑不再对 4xx 发起请求。\n', '');
  const { code, out } = runCheck(report);
  assert.notEqual(code, 0, out);
  assert.match(out, /缺少修复项: 4xx 不再重试/);
});

test('只写「修复了 3 个问题」但没有事实判不过', () => {
  const report = `## 版本
2.1.0，含 1 个破坏性变更：run() 返回 Promise。

## 修复
本版共修复了 3 个问题。

## 风险
p95 从 240ms 降到 180ms；INC-2041 的根因是连接池耗尽。

## 下一步
补 12 个回归测试。
`;
  const { code, out } = runCheck(report);
  assert.notEqual(code, 0, out);
  assert.match(out, /缺少修复项/);
});

test('只提到 xlsx 但没说合计行/公式问题判不过', () => {
  const report = reportA.replace('- xlsx 导出合计行的公式引用错行已修正。', '- xlsx 导出文件已更新。');
  const { code, out } = runCheck(report);
  assert.notEqual(code, 0, out);
  assert.match(out, /缺少修复项: xlsx/);
});

test('测试数量不是 12 (写成 8) 判不过', () => {
  const report = reportA.replace('补 12 个回归测试', '补 8 个回归测试');
  const { code, out } = runCheck(report);
  assert.notEqual(code, 0, out);
  assert.match(out, /12 个回归测试/);
});

test('120 不能被当成 12 判过', () => {
  const report = reportA.replace('补 12 个回归测试', '补 120 个回归测试');
  const { code, out } = runCheck(report);
  assert.notEqual(code, 0, out);
  assert.match(out, /12 个回归测试/);
});
