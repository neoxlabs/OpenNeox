import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../../../..');

/** 读 PNG 的宽高 + alpha 包围盒 (只解 PNG header + 用 sharp 兜不住时的最小实现) */
function pngSize(buf: Buffer): { w: number; h: number } {
  /* IHDR: 8 字节签名 + 4 长度 + 4 类型, 然后是宽高 */
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe('应用图标: mac 留边距 / win 近全出血, 两张图分开', () => {
  it('mac 用的 PNG 是 1024 画布 (跟 icon.icns 同源)', () => {
    for (const p of ['build/icon.png', 'apps/desktop/src/ui/renderer/assets/icon.png']) {
      const { w, h } = pngSize(readFileSync(join(ROOT, p)));
      expect(`${p} ${w}x${h}`).toBe(`${p} 1024x1024`);
    }
  });

  it('Windows 用的 PNG 单独一份, 不再覆盖 mac 那张', () => {
    for (const p of ['build/icon-win.png', 'apps/desktop/src/ui/renderer/assets/icon-win.png']) {
      const { w } = pngSize(readFileSync(join(ROOT, p)));
      expect(w).toBe(256);
    }
  });

  it('win 图标脚本只许写 -win 那两个文件', () => {
    const src = readFileSync(join(ROOT, 'scripts/generate-win-icon.cjs'), 'utf8');
    const outs = src.slice(src.indexOf('const extraPngs'), src.indexOf('const extraPngs') + 400);
    expect(outs).toContain('build/icon-win.png');
    expect(outs).toContain('assets/icon-win.png');
    expect(outs).not.toMatch(/'build\/icon\.png'/);
    expect(outs).not.toMatch(/assets\/icon\.png'/);
  });

  it('macOS 的 dock 图标候选以 .icns 打头 (它才有 Apple 网格的边距)', () => {
    const src = readFileSync(join(ROOT, 'apps/desktop/src/ui/electron/services/appIcon.ts'), 'utf8');
    /* 只看**返回的那个数组**, 不看上面解释性的注释 (注释里也会出现这些文件名) */
    const branch = src.slice(src.indexOf("platform === 'darwin'"));
    const arr = branch.slice(branch.indexOf('return ['), branch.indexOf('];'));
    const first = arr.indexOf('icon.icns');
    const png = arr.indexOf('icon.png');
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(png);
  });
});
