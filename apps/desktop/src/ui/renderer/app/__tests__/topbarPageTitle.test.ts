import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');          /* → renderer */
const HOST = readFileSync(join(__dirname, '..', 'NeoxShellHost.tsx'), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe('顶栏页面标题', () => {
  it('源文件读到了 —— 路径错会让整组闸静悄悄什么都不测', () => {
    expect(HOST.length).toBeGreaterThan(5000);
    expect(HOST).toContain('activeShellWorkTitle');
  });

  it('用查表而不是三元链 —— 三元链漏一个只会安静落进 else', () => {
    expect(HOST).toMatch(/const PAGE_TITLES: Record<string, \[string, string\]>/);
    expect(HOST).not.toMatch(/agentPage === 'knowledge' \? pageTitle/);
  });

  it('agentPage 的每一个非 chat 取值都在表里', () => {
    /* 扫全渲染层, 而不是只看这一个文件 —— 新页面的判断可能写在别处 */
    const seen = new Set<string>();
    for (const f of walk(ROOT)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/agentPage\s*===?\s*'([a-z-]+)'/g)) seen.add(m[1]);
      for (const m of src.matchAll(/setAgentPage\('([a-z-]+)'\)/g)) seen.add(m[1]);
    }
    seen.delete('chat');                     /* chat 就该显示会话名 */
    expect(seen.size, '没扫到任何 agentPage 取值, 判据本身失效了').toBeGreaterThan(3);

    const table = /const PAGE_TITLES[\s\S]*?\n  \};/.exec(HOST)?.[0] ?? '';
    expect(table, '找不到 PAGE_TITLES').not.toBe('');
    const missing = [...seen].filter(k => !new RegExp(`\\b${k}:\\s*\\[`).test(table)).sort();
    expect(
      missing,
      `这些页面没有顶栏标题, 打开时会显示上一个会话名: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('文案跟侧栏入口逐字一致 —— 顶栏和侧栏说的必须是同一个词', () => {
    const table = /const PAGE_TITLES[\s\S]*?\n  \};/.exec(HOST)?.[0] ?? '';
    for (const [zh, en] of [['技能', 'Skills'], ['图片', 'Images'], ['团队', 'Team'], ['插件', 'Plugins']]) {
      expect(table, `${zh} 的中英文案要跟侧栏一致`).toContain(`'${zh}'`);
      expect(table).toContain(`'${en}'`);
    }
  });
});
