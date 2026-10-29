import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert, findFile, runCheck, workdirFromArgv } from '../../lib/check-helpers.mjs';
import { cellText, readXlsx } from '../../lib/xlsx.mjs';

const COLUMNS = [
  ['研发', 120000, 131500],
  ['市场', 48000, 44200],
  ['云资源', 36000, 39900],
  ['办公', 12000, 9800],
  ['差旅', 15000, 17250],
];

const normalizeFormula = (cell) => String(cell?.formula ?? '').replace(/^=/, '').replace(/\s+/g, '').toUpperCase();

runCheck(async () => {
  const workdir = workdirFromArgv();
  const preferred = path.join(workdir, 'out', 'budget.xlsx');
  const file = fs.existsSync(preferred)
    ? preferred
    : findFile(workdir, (name) => name.toLowerCase().endsWith('.xlsx'), { maxDepth: 3 });
  assert(file, '没有找到 xlsx 文件');

  const workbook = readXlsx(file);
  const sheet = workbook.sheets.find((item) => item.name.trim().toLowerCase() === 'budget') ?? workbook.sheets[0];
  assert(sheet, 'xlsx 里没有任何工作表');

  const header = ['A1', 'B1', 'C1', 'D1'].map((ref) => cellText(sheet.cells.get(ref)));
  assert(
    header.join('|') === '类别|预算|实际|差异',
    `表头应为 类别|预算|实际|差异, 实际 ${header.join('|')}`,
  );

  COLUMNS.forEach(([category, budget, actual], index) => {
    const row = index + 2;
    const label = cellText(sheet.cells.get(`A${row}`));
    assert(label === category, `A${row} 应为 ${category}, 实际 ${label || '(空)'}`);
    const budgetCell = sheet.cells.get(`B${row}`);
    const actualCell = sheet.cells.get(`C${row}`);
    assert(Math.abs(Number(budgetCell?.value) - budget) < 0.01, `B${row} 应为数值 ${budget}, 实际 ${budgetCell?.value}`);
    assert(Math.abs(Number(actualCell?.value) - actual) < 0.01, `C${row} 应为数值 ${actual}, 实际 ${actualCell?.value}`);
    const formula = normalizeFormula(sheet.cells.get(`D${row}`));
    assert(formula === `C${row}-B${row}`, `D${row} 应为公式 =C${row}-B${row}, 实际 ${formula || '(无公式)'}`);
  });

  const totalLabel = cellText(sheet.cells.get('A7'));
  assert(/合计|总计|total/i.test(totalLabel), `A7 应为合计行, 实际 ${totalLabel || '(空)'}`);
  assert(normalizeFormula(sheet.cells.get('B7')) === 'SUM(B2:B6)', `B7 应为 =SUM(B2:B6), 实际 ${normalizeFormula(sheet.cells.get('B7'))}`);
  assert(normalizeFormula(sheet.cells.get('C7')) === 'SUM(C2:C6)', `C7 应为 =SUM(C2:C6), 实际 ${normalizeFormula(sheet.cells.get('C7'))}`);
  const totalDiff = normalizeFormula(sheet.cells.get('D7'));
  assert(
    totalDiff === 'SUM(D2:D6)' || totalDiff === 'C7-B7',
    `D7 应为 =SUM(D2:D6) 或 =C7-B7, 实际 ${totalDiff || '(无公式)'}`,
  );
});
