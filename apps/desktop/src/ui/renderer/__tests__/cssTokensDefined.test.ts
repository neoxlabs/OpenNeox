
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

/** 故意不定义的 —— 定义了反而是 bug, 见 theme-tokens/neox.css 里那段说明 */
const INTENTIONALLY_UNDEFINED = new Set([
  /* 用户拖动侧栏/右栏时由 NeoxShell 内联写上去; 未定义 = 没拖过, calc 兜底才生效 */
  '--neox-shell-sidebar-user',
  '--neox-shell-right-user',
  /* 质感(材质)包开启时才有; 未定义 = 关闭态 */
  '--neox-mat-regular-shadow',
  /* 悬浮壳挡桌面壁纸的那层白雾 —— 动过一次把深色壁纸糊掉, 已回退, 不碰 */
  '--neox-shell-surface',
]);

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.(css|ts|tsx)$/.test(name)) out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

const used = new Set<string>();
const defined = new Set<string>();
for (const file of sources()) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/var\(\s*(--neox-[\w-]+)\s*[,)]/g)) used.add(m[1]);
  for (const m of src.matchAll(/(--neox-[\w-]+)\s*:/g)) defined.add(m[1]);
}

describe('CSS token 定义完整性', () => {
  it('对照组: 确实扫到了 token (扫不到就是闸瞎了)', () => {
    expect(used.size).toBeGreaterThan(200);
    expect(defined.size).toBeGreaterThan(200);
    expect(defined.has('--neox-bg-subtle')).toBe(true); // 出这条闸的那一个
  });

  it('用到的 token 全都有定义 (故意留空的那几个除外)', () => {
    const missing = [...used].filter((t) => !defined.has(t) && !INTENTIONALLY_UNDEFINED.has(t)).sort();
    expect(missing, `这些 token 在用却没有定义: ${missing.join(' / ')}。`
      + '未定义的 var 会安静地退成各处自己写的兜底值 —— 同一语义在不同文件里不同颜色, '
      + '而且一律不跟主题走 (暗色下常常是一块白)。').toEqual([]);
  });
});
