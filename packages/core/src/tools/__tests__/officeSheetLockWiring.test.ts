/**
 * work E-05 接线验证 —— 方案点名的场景是「用户正开着表, 改完写不进去」。
 * helper 与 word_create 已有用例 (officeFileLock.test.ts / officeWriteLockWiring.test.ts),
 * 这里补上真正改用户已有 .xlsx 的那条路 (sheet_set_cells):
 *
 *   - Excel 开着 (同目录有 `~$book.xlsx`) → 返回可执行的中文提示, 原表一个字节不动;
 *   - 提示里的「另存到新路径」真的能走通 (save_as 指向未被占用的文件);
 *   - 用户关掉 Excel (锁文件消失) 后重试即成功。
 *
 * 不 mock fs: 表用 sheet_new_workbook + sheet_write_range + sheet_export 真写出来,
 * 改完再用 SheetJS 读回来核对内容。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sheetSetCellsTool } from '../sheet/sheetEditTools.js';
import { sheetNewWorkbookTool, sheetWriteRangeTool, sheetExportFileTool } from '../sheet/sheetWriteTools.js';

const call = async (tool: any, args: any) => JSON.parse(String(await tool.function(args)));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-sheet-lock-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function makeWorkbook(name = 'book.xlsx'): Promise<string> {
  const { workbook_id } = await call(sheetNewWorkbookTool, {});
  const written = await call(sheetWriteRangeTool, { workbook_id, range: 'A1', data: [['原值']] });
  expect(written.error).toBeUndefined();
  const out = path.join(dir, name);
  const exported = await call(sheetExportFileTool, { workbook_id, save_path: out });
  expect(exported.error).toBeUndefined();
  return out;
}

function readA1(file: string): string {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return String(ws?.A1?.v ?? '');
}

describe('sheet_set_cells × Excel 开着', () => {
  it('返回「关掉 Excel → 重试 / 另存」的中文提示, 且原表内容不变', async () => {
    const target = await makeWorkbook();
    fs.writeFileSync(path.join(dir, '~$book.xlsx'), '');

    const payload = await call(sheetSetCellsTool, {
      file_path: target,
      cells: [{ cell: 'A1', value: '新值' }],
    });

    expect(payload.ok).toBeUndefined();
    expect(payload.error).toContain('文件被占用');
    expect(payload.error).toContain('Excel');
    expect(payload.error).toContain('关掉');
    expect(payload.error).toContain('重试');
    expect(readA1(target)).toBe('原值');
  }, 20_000);

  it('另存到新路径不受原文件占用影响 (提示里的第二条出路)', async () => {
    const target = await makeWorkbook();
    fs.writeFileSync(path.join(dir, '~$book.xlsx'), '');

    const saveAs = path.join(dir, 'book-copy.xlsx');
    const payload = await call(sheetSetCellsTool, {
      file_path: target,
      save_as: saveAs,
      cells: [{ cell: 'A1', value: '新值' }],
    });

    expect(payload.error).toBeUndefined();
    expect(payload.ok).toBe(true);
    expect(payload.file_path).toBe(saveAs);
    expect(readA1(saveAs)).toBe('新值');
    expect(readA1(target)).toBe('原值');
  }, 20_000);

  it('用户关掉 Excel (锁文件消失) 后重试即成功', async () => {
    const target = await makeWorkbook();
    const lockFile = path.join(dir, '~$book.xlsx');
    fs.writeFileSync(lockFile, '');

    const blocked = await call(sheetSetCellsTool, {
      file_path: target,
      cells: [{ cell: 'A1', value: '第一次' }],
    });
    expect(blocked.error).toContain('文件被占用');

    fs.rmSync(lockFile);
    const ok = await call(sheetSetCellsTool, {
      file_path: target,
      cells: [{ cell: 'A1', value: '第二次' }],
    });

    expect(ok.error).toBeUndefined();
    expect(ok.ok).toBe(true);
    expect(readA1(target)).toBe('第二次');
  }, 20_000);
});
