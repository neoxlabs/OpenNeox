import * as fs from 'node:fs';
import * as path from 'node:path';
import { cellStyle, columnWidth, readXlsx } from '../../lib/xlsx.mjs';
import { assert, assertAnyOf, runCheck, workdirFromArgv } from '../../lib/check-helpers.mjs';

const formula = (sheet, ref) => String(sheet.cells.get(ref)?.formula ?? '').replace(/^=/, '').replace(/\s+/g, '').toUpperCase();
const value = (sheet, ref) => sheet.cells.get(ref)?.value;

runCheck(async () => {
  const workdir = workdirFromArgv();
  const file = path.join(workdir, 'out/sales.xlsx');
  assert(fs.existsSync(file), '没有生成 out/sales.xlsx');

  const wb = readXlsx(file);
  const sheet = wb.sheets.find((s) => s.name === 'Sales');
  assert(sheet, `找不到工作表 Sales (现有: ${wb.sheets.map((s) => s.name).join(', ')})`);

  const header = ['A1', 'B1', 'C1', 'D1', 'E1'].map((ref) => String(value(sheet, ref) ?? '').trim());
  assert(header.join('|') === '产品|单价|数量|金额|占比', `表头不对: ${header.join('|')}`);

  const rows = [
    ['键盘', 199, 12],
    ['显示器', 1299, 4],
    ['鼠标', 89, 25],
    ['耳机', 499, 7],
  ];
  rows.forEach(([name, price, qty], i) => {
    const row = i + 2;
    assert(String(value(sheet, `A${row}`) ?? '').includes(name), `A${row} 应为 ${name}`);
    assert(Number(value(sheet, `B${row}`)) === price, `B${row} 应为 ${price}`);
    assert(Number(value(sheet, `C${row}`)) === qty, `C${row} 应为 ${qty}`);
  });

  for (let row = 2; row <= 5; row += 1) {
    const d = formula(sheet, `D${row}`);
    assert(/B\d+\*C\d+/.test(d), `D${row} 应为单价*数量公式, 实际 ${d || '(空)'}`);
    const e = formula(sheet, `E${row}`);
    /* 分母可以是 SUM($D$2:$D$5), 也可以直接引用合计单元格 $D$6 —— 两种都算对 */
    assert(
      /^D\d+\//.test(e) && (/SUM\(/.test(e) || /\$?D\$?6/.test(e)),
      `E${row} 应用金额/金额合计的占比公式, 实际 ${e || '(空)'}`,
    );
  }

  assert(String(value(sheet, 'A6') ?? '').includes('合计'), 'A6 应为「合计」');
  assert(/SUM\(C2:C5\)/.test(formula(sheet, 'C6')), `C6 应为 SUM(C2:C5), 实际 ${formula(sheet, 'C6')}`);
  assert(/SUM\(D2:D5\)/.test(formula(sheet, 'D6')), `D6 应为 SUM(D2:D5), 实际 ${formula(sheet, 'D6')}`);

  const headStyle = cellStyle(sheet, 'A1');
  assert(headStyle.bold, '表头没有加粗');
  assert(headStyle.fill, '表头没有底色');

  const moneyStyle = cellStyle(sheet, 'B2');
  assertAnyOf(String(moneyStyle.numFmt ?? ''), [/[#0],##0\.00/, /#,##0/, /0\.00/], '单价列没有千分位/两位小数格式');
  const amountStyle = cellStyle(sheet, 'D2');
  assertAnyOf(String(amountStyle.numFmt ?? ''), [/[#0],##0\.00/, /#,##0/, /0\.00/], '金额列没有数字格式');

  const widths = [0, 1, 2, 3, 4].map((i) => columnWidth(sheet, i));
  assert(widths.every((w) => w && w > 0), `A-E 列都要设列宽, 实际 ${JSON.stringify(widths)}`);
});
