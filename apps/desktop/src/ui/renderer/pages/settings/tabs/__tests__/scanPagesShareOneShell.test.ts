import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(HERE, rel), 'utf8');

const shell = read('../scanShell.tsx');
const provider = read('../ProviderScanImport.tsx');
const skill = read('../SkillScanImport.tsx');
const skillForm = read('../SkillEditForm.tsx');

describe('两个扫描页共用一套外壳', () => {
  it('样式只有 scanShell 一份 —— 谁都不许自己再写一套', () => {
    expect(shell).toMatch(/nx-scan__src\[data-state="live"\]/);
    for (const [name, src] of [['provider', provider], ['skill', skill]] as const) {
      expect(src, `${name} 应该引 scanShell`).toMatch(/from '\.\/scanShell'/);
      /* 自带 <style> 块 = 又一份会漂的样式 */
      expect(src, `${name} 不该自己写 <style>`).not.toMatch(/<style>\{/);
    }
  });

  it('两页都有扫描动画 (逐条报源) 且源清单不为空', () => {
    for (const [name, src] of [['provider', provider], ['skill', skill]] as const) {
      expect(src, `${name} 缺扫描中逐条亮的源清单`).toMatch(/<ScanSources[^>]*at=\{busy \? probing/);
      expect(src, `${name} 缺 SOURCES`).toMatch(/const SOURCES: ScanSource\[\] = \[/);
      const block = src.slice(src.indexOf('const SOURCES'), src.indexOf('];', src.indexOf('const SOURCES')));
      expect(block.split('{ zh:').length - 1, `${name} 的源清单是空的`).toBeGreaterThan(1);
    }
  });

  it('两页都是"先扫描→再勾选→批量导入", 不是一进来就铺列表', () => {
    for (const [name, src] of [['provider', provider], ['skill', skill]] as const) {
      /* 起手式: 一颗按钮, scan 还是 null 时不铺任何列表 (扫描中也是这一屏) */
      expect(src, `${name} 缺起手按钮`).toMatch(/scan === null \|\| busy/);
      expect(src, `${name} 缺勾选`).toMatch(/role="checkbox"/);
      expect(src, `${name} 缺批量导入`).toMatch(/导入 \$\{importable\.length\} 个/);
      /* 挂载即扫 = 主动扫描, 不许 */
      expect(src, `${name} 不许挂载就扫`).not.toMatch(/useEffect\([^)]*runScan/);
    }
  });

  it('技能扫描是独占一屏, 不再平铺在导入页里', () => {
    /* 老实现: 扫描结果直接铺在 URL 导入表单下面 */
    expect(skillForm).toMatch(/scanMode/);
    expect(skillForm).toMatch(/<SkillScanImport/);
    /* 旧的分页/搜索/逐条导入状态必须已经清掉, 否则就是两份真相 */
    expect(skillForm).not.toMatch(/EXTERNAL_PAGE_SIZE/);
    expect(skillForm).not.toMatch(/setExternalScanned/);
  });

  it('扫描动画的计时器不许在 finally 里立刻清 —— 那样进度条永远停在第一条', () => {
    for (const [name, src] of [['provider', provider], ['skill', skill]] as const) {
      const fin = src.slice(src.indexOf('} finally {'), src.indexOf('}, []);'));
      expect(fin, `${name}: clearInterval 必须在 setTimeout 里跟 busy 一起收`)
        .toMatch(/setTimeout\(\(\) => \{[\s\S]*clearInterval/);
    }
  });

  it('scanShell 不带边框 —— 结果行之间只有发丝线', () => {
    /* 第二版结果行 .nx-scan__item: 悬停有浅底 (圆角只给悬停底用), 不画框; 行间是 inset 发丝线 */
    const row = shell.slice(shell.indexOf('.nx-scan__item {'), shell.indexOf('}', shell.indexOf('.nx-scan__item {')));
    expect(row).not.toMatch(/border: 1px/);
    expect(row).not.toMatch(/border:\s*\d/);
    expect(shell).toMatch(/\.nx-scan__item \+ \.nx-scan__item \{ box-shadow: inset 0 1px 0/);
  });

  it('共用外壳文件在', () => {
    expect(existsSync(resolve(HERE, '../scanShell.tsx'))).toBe(true);
  });
});
