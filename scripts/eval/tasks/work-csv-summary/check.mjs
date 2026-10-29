import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert, assertAnyOf, runCheck, workdirFromArgv } from '../../lib/check-helpers.mjs';

runCheck(async () => {
  const workdir = workdirFromArgv();
  const file = path.join(workdir, 'SUMMARY.md');
  assert(fs.existsSync(file), '没有生成 SUMMARY.md');
  const text = fs.readFileSync(file, 'utf8');
  assert(text.trim().length > 40, 'SUMMARY.md 内容太少');

  assertAnyOf(text, [/4[,，]?870/, /4870/], '已完成订单总收入应为 4870');
  assertAnyOf(text, [/2[,，]?086/, /2086/], '华东合计应为 2086');
  assertAnyOf(text, [/1[,，]?997/, /1997/], '华北合计应为 1997');
  assert(/\b787\b/.test(text), '华南合计应为 787');
  assert(/显示器/.test(text), '收入最高的产品应为显示器');
  assertAnyOf(text, [/取消[^\n。]{0,12}2\s*(?:笔|条|个|单)?/, /2\s*(?:笔|条|个|单)[^\n。]{0,6}取消/], '取消订单数应为 2');

  const tableLines = text.split('\n').filter((line) => line.includes('|'));
  const regionTable = tableLines.some((line) => ['华东', '华北', '华南'].every((region) => line.includes(region)))
    || (tableLines.some((line) => line.includes('华东')) && tableLines.some((line) => line.includes('华北')) && tableLines.some((line) => line.includes('华南')));
  assert(regionTable, '没有用 markdown 表格展示各区域合计');
});
