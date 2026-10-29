/**
 * work H-13: 大表读取默认摘要 + 抽样。
 *
 * 验收口径: >2000 行默认摘要, 全量需显式参数 (full=true)。
 * 这里用真实 CSV 文件走 sheet_get_range 的完整读盘路径 (SheetJS 解析 + 安全闸),
 * 断言的是模型实际看到的那段文本, 不是中间态。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sheetGetRangeTool } from '../sheetTools.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function writeCsv(rows: number, cols = 3): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-big-table-'));
  dirs.push(dir);
  const file = path.join(dir, 'big.csv');
  const header = Array.from({ length: cols }, (_, c) => `col${c + 1}`).join(',');
  const lines = [header];
  for (let r = 1; r <= rows; r++) {
    lines.push(Array.from({ length: cols }, (_, c) => `r${r}c${c + 1}`).join(','));
  }
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

async function read(args: Record<string, unknown>): Promise<string> {
  return String(await (sheetGetRangeTool as any).function(args));
}

describe('sheet_get_range 大表摘要 (H-13)', () => {
  it('5000 行默认返回摘要 + 抽样, 不返回全量', async () => {
    const file = writeCsv(5000);
    const out = await read({ file_path: file });

    expect(out).toMatch(/大表摘要/);
    /* 5000 条数据 + 1 行表头 */
    expect(out).toMatch(/5001 行 × 3 列/);
    expect(out).toMatch(/阈值 2000 行/);
    /* 头尾都在抽样里, 中间被跳过 */
    expect(out).toContain('r1c1');
    expect(out).toContain('r5000c1');
    /* 摘要必须给出"怎么读全量" */
    expect(out).toMatch(/full=true/);
    expect(out).toMatch(/range="/);
    /* 关键: 不是 5000 行原文 (每行 ~30 字符, 全量会 >150k) */
    expect(out.length).toBeLessThan(20_000);
    expect(out).not.toContain('r2500c1');
  });

  it('full=true 才返回全量 (5000 行都在)', async () => {
    const file = writeCsv(5000);
    const out = await read({ file_path: file, full: true });

    expect(out).not.toMatch(/大表摘要/);
    expect(out).toContain('r1c1');
    expect(out).toContain('r2500c1');
    expect(out).toContain('r5000c1');
    expect(out.length).toBeGreaterThan(100_000);
  });

  it('小表 (≤2000 行) 行为不变: 直接给表格, 没有摘要', async () => {
    const file = writeCsv(100);
    const out = await read({ file_path: file });

    expect(out).not.toMatch(/大表摘要/);
    expect(out).toContain('| col1 | col2 | col3 |');
    expect(out).toContain('r100c1');
  });

  it('显式小 range 照旧返回那一段, 不受摘要影响', async () => {
    const file = writeCsv(5000);
    const out = await read({ file_path: file, range: 'A1:C5' });

    expect(out).not.toMatch(/大表摘要/);
    expect(out).toContain('r4c1');
    expect(out).not.toContain('r6c1');
  });

  it('显式 range 超过 2000 行也走摘要 (range 不等于绕过摘要)', async () => {
    const file = writeCsv(5000);
    const out = await read({ file_path: file, range: 'A1:C4000' });

    expect(out).toMatch(/大表摘要/);
    expect(out).toMatch(/4000 行 × 3 列/);
    expect(out.length).toBeLessThan(20_000);
  });
});
