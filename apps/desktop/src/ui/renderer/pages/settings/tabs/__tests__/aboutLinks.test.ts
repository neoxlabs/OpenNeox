import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'AboutTab.tsx'), 'utf8');
const CODE = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length));

describe('关于页的外链', () => {
  it('测试指着的确实是 AboutTab (路径自检)', () => {
    expect(CODE).toContain('about-link-item');
    expect(CODE).toContain('productLinks');
  });

  it('没有裸的 onClick={() => openExternal(...)} 了', () => {
    expect(CODE,
      '这种写法失败时用户什么都看不到 —— 要走带 .catch 的封装')
      .not.toMatch(/onClick=\{\(\) => window\.neox\?\.openExternal\(/);
  });

  it('打开失败要派 op-failed 给用户看', () => {
    expect(CODE).toMatch(/import \{[^}]*dispatchOpFailed/);
    const at = CODE.indexOf('openExternal');
    expect(at).toBeGreaterThan(0);
    expect(CODE.slice(at, at + 420), 'openExternal 之后要 .catch 并 dispatchOpFailed')
      .toMatch(/\.catch\([\s\S]*dispatchOpFailed/);
  });

  it('键盘按得到: role + tabIndex + Enter/Space', () => {
    const at = CODE.indexOf('className="about-link-item"');
    expect(at).toBeGreaterThan(0);
    const tag = CODE.slice(at, at + 420);
    expect(tag).toMatch(/role="button"/);
    expect(tag).toMatch(/tabIndex=\{0\}/);
    expect(tag, '光有 role 不够, div 不会自己响应 Enter/Space').toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
  });

  it('键盘焦点看得见 —— 这些行是 div, 没有默认聚焦样式', () => {
    const parts: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        if (e === 'node_modules' || e === '__tests__') continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.css$/.test(e)) parts.push(readFileSync(p, 'utf8'));
      }
    };
    /* __tests__ → tabs → settings → pages → renderer, 是 **4** 层不是 3 层。
     * 第一版少算一级, 指到了不存在的 pages/styles —— 幸好上面那条自检式断言让它
     * 响亮地 ENOENT 失败, 而不是扫到空目录后静默通过。 */
    walk(join(__dirname, '..', '..', '..', '..', 'styles'));
    expect(parts.join('\n')).toMatch(/\.about-link-item:focus-visible/);
  });
});
