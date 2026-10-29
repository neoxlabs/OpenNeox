import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, '../pages/settings/tabs/SkillsTab.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('技能空态', () => {
  it('会去扫机器上现成的外部技能', () => {
    expect(src).toMatch(/skillsDiscoverExternal/);
    expect(src).toMatch(/importableCount/);
  });

  it('只数还没导入过的 —— 已导入的再报一遍是噪声', () => {
    expect(src).toMatch(/filter\(\(x\) => !x\?\.alreadyImported\)/);
  });

  it('有现成的就报数, 中英文都要报', () => {
    expect(src).toMatch(/检测到 \$\{importableCount\} 个可以从 Claude Code \/ Codex 直接导入/);
    expect(src).toMatch(/Found \$\{importableCount\} ready to import/);
  });

  it('导入按钮也带上数量', () => {
    expect(src).toMatch(/导入 \$\{importableCount\} 个技能/);
    expect(src).toMatch(/Import \$\{importableCount\} skills/);
  });

  /* 老 main 没有这个 IPC / 扫不到 / 数量为 0 时必须回落原文案, 不许编数字 */
  it('扫不到时回落原文案, 不编数字', () => {
    expect(src).toMatch(/typeof api\?\.skillsDiscoverExternal !== 'function'/);
    expect(src).toMatch(/'从 Claude Code \/ Codex 导入，或自己写一个。'/);
    expect(src).toMatch(/importableCount && importableCount > 0/);
  });
});
