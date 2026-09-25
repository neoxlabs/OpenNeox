/**
 * Fuzzy matching preserves the indentation of the matched source line even
 * when the requested text omits indentation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEditFileTool } from '../editFileTool.js';

let dir: string;

const mkTool = () => createEditFileTool({
  resolveWorkspacePath: (p?: string) => path.resolve(dir, p ?? '.'),
  formatDisplayPath: (abs: string) => path.relative(dir, abs),});

const write = async (rel: string, content: string) => {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return abs;
};
const read = (rel: string) => fs.readFile(path.join(dir, rel), 'utf8');

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-reindent-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('edit: 模糊命中后还原缩进', () => {
  it('old_string 少了前导空格 — 替换后原缩进必须还在 (JS)', async () => {
    const src = [
      'const COUPONS = {',
      "  SAVE10:   { kind: 'percent', label: '10% off' },",
      "  SAVE25:   { kind: 'percent', label: '25% off' },",
      '};',
      '',
    ].join('\n');
    await write('coupon.mjs', src);
    const tool = mkTool();
    await tool.function({
      file_path: 'coupon.mjs',
  /* The requested text omits the source indentation. */
      old_string: "SAVE25:   { kind: 'percent', label: '25% off' },",
      new_string: "SAVE25:   { kind: 'percent', label: '25% 立减' },",
    });
    const out = await read('coupon.mjs');
    expect(out).toContain("  SAVE25:   { kind: 'percent', label: '25% 立减' },");
    expect(out).not.toContain("\nSAVE25:");
    /* 邻居不能被殃及 */
    expect(out).toContain("  SAVE10:   { kind: 'percent', label: '10% off' },");
  });

  it('Python: 少抄缩进的编辑不能改变语法结构', async () => {
    const src = [
      'class Config:',
      '    TAX_RATE = 0.08',
      '    def rate(self):',
      '        return self.TAX_RATE',
      '',
    ].join('\n');
    await write('config.py', src);
    await mkTool().function({
      file_path: 'config.py',
      old_string: 'TAX_RATE = 0.08',
      new_string: 'TAX_RATE = 0.09',
    });
    const out = await read('config.py');
    expect(out).toContain('    TAX_RATE = 0.09');
    expect(out.split('\n')[1]).toBe('    TAX_RATE = 0.09');
  });

  it('YAML: 嵌套两层的键改值, 缩进原样保留', async () => {
    const src = [
      'service:',
      '  limits:',
      '    memory: 256Mi',
      '',
    ].join('\n');
    await write('settings.yaml', src);
    await mkTool().function({
      file_path: 'settings.yaml',
      old_string: 'memory: 256Mi',
      new_string: 'memory: 512Mi',
    });
    expect(await read('settings.yaml')).toContain('    memory: 512Mi');
  });

  it('多行替换: 统一施加缩进差, 块内相对缩进不被压平', async () => {
    const src = [
      'def outer():',
      '    if flag:',
      '        do_a()',
      '        do_b()',
      '',
    ].join('\n');
    await write('multi.py', src);
    await mkTool().function({
      file_path: 'multi.py',
      /* 整块少了 4 空格 */
      old_string: 'if flag:\n    do_a()\n    do_b()',
      new_string: 'if flag:\n    do_a()\n    do_c()',
    });
    const out = await read('multi.py');
    expect(out).toContain('    if flag:');
    expect(out).toContain('        do_a()');
    expect(out).toContain('        do_c()');
  });

  it('old_string 缩进抄对时行为不变 (不重复加缩进)', async () => {
    await write('exact.py', 'class C:\n    X = 1\n');
    await mkTool().function({
      file_path: 'exact.py',
      old_string: '    X = 1',
      new_string: '    X = 2',
    });
    const out = await read('exact.py');
    expect(out).toContain('    X = 2');
    expect(out).not.toContain('        X = 2');
  });

  it('内容真的不同(不只是空白差异)时不做任何缩进推断', async () => {
    await write('plain.txt', '    hello world\n');
    await mkTool().function({
      file_path: 'plain.txt',
      old_string: '    hello world',
      new_string: 'goodbye',
    });
    /* 缩进抄对了 → 走精确匹配 → new_string 原样, 不该被补缩进 */
    expect(await read('plain.txt')).toBe('goodbye\n');
  });
});
