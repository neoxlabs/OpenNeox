import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../neox-cards.css'), 'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ');   /* 剥注释 —— 上面的说明里逐字引着这些值 */

/** 取某个选择器块里的 flex-shrink (`flex: g s b` 的第二位) */
function shrinkOf(sel: string): number | null {
  const m = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) return null;
  const f = /flex\s*:\s*(\d+)\s+(\d+)\s/.exec(m[1]);
  return f ? Number(f[2]) : null;
}

describe('summary 文件行的压缩优先级', () => {
  it('自检: 四个选择器都还在 (改名了这条先红, 而不是下面平凡通过)', () => {
    for (const s of ['.nsum__file-path', '.nsum__file-note', '.nsum__file-bar', '.nsum__file-num']) {
      expect(new RegExp(`\\${s}\\s*\\{`).test(css), `${s} 不见了`).toBe(true);
    }
  });

  it('数字永不让位 —— 被裁掉一位的数字看起来像个正常的数, 比没有更糟', () => {
    expect(shrinkOf('.nsum__file-num')).toBe(0);
  });

  it('让位顺序: 进度条 > 说明 > 路径 (条只是数字的可视化, 数字就在旁边)', () => {
    const bar = shrinkOf('.nsum__file-bar');
    const note = shrinkOf('.nsum__file-note');
    const path = shrinkOf('.nsum__file-path');
    expect(bar).not.toBeNull(); expect(note).not.toBeNull(); expect(path).not.toBeNull();
    expect(bar!).toBeGreaterThan(note!);
    expect(note!).toBeGreaterThan(path!);
    expect(path!).toBeGreaterThan(0);   /* 路径也得能让, 否则窄到极限还是溢出 */
  });

  it('能让位的三个都要 min-width:0 —— 少了它 flex 项收不到内容宽以下', () => {
    for (const sel of ['.nsum__file-path', '.nsum__file-note', '.nsum__file-bar']) {
      const block = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css)![1];
      expect(/min-width\s*:\s*0/.test(block), `${sel} 缺 min-width:0`).toBe(true);
    }
  });

  it('说明压窄了要出省略号, 不能硬裁', () => {
    const block = /\.nsum__file-note\s*\{([^}]*)\}/.exec(css)![1];
    expect(/text-overflow\s*:\s*ellipsis/.test(block)).toBe(true);
    expect(/overflow\s*:\s*hidden/.test(block)).toBe(true);
  });
});
