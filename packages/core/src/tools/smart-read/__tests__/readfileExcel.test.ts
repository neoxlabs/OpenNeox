import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { getTools } from '../../runtimeTools';

describe('readfile 读 Excel', () => {
  test('返回整张表, 生僻字一字不差', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-xlsx-'));
    const file = path.join(dir, '名单.xlsx');
    const names = ['廖语嫣', '张天佑', '邹嘉豪', '朱雨萱', '陶皓轩', '蔡睿泽'];
    const ws = XLSX.utils.aoa_to_sheet([['学号', '姓名'], ...names.map((n, i) => [i + 1, n])]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '初二(3)班');
    XLSX.writeFile(wb, file);
    const rf: any = (await getTools(dir)).find((t: any) => t.name === 'readfile');
    const out = String(await rf.function({ file_path: file }));
    expect(out).toContain('[Excel] 名单.xlsx');
    for (const n of names) expect(out).toContain(n);
    expect(out).not.toMatch(/&#\d+;/);
    expect(out).not.toContain('Cannot read binary');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
