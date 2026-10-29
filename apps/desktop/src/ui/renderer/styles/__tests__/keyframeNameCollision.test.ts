import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');   // src/ui

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.css$/.test(e)) out.push(p);
  }
  return out;
}

function collect(): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const f of walk(ROOT)) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{/g)) {
      /* 花括号配对找 body —— 正则的 [^}]* 会在第一个 `100% { … }` 就断掉 */
      let i = (m.index ?? 0) + m[0].length - 1, d = 0;
      for (; i < s.length; i++) {
        if (s[i] === '{') d++;
        else if (s[i] === '}') { d--; if (d === 0) break; }
      }
      const body = s.slice((m.index ?? 0) + m[0].length, i).replace(/\s+/g, ' ').trim();
      if (!byName.has(m[1])) byName.set(m[1], new Set());
      byName.get(m[1])!.add(body);
    }
  }
  return byName;
}

/* 已知欠账: 只许减不许加 */
const KNOWN_DIVERGENT = [
  'pulse',        // 3 份内容不同 / 7 个使用方 —— 见文件头, 恢复任何一份都是设计决定
  /* 下面三个都是旋转动画的两种写法: `to { rotate(360deg) }` 对
   * `from { rotate(0) } to { rotate(360deg) }`。绝大多数情况等价, 但**隐式 from 取的是
   * 元素当前值** —— 元素自身带 transform: rotate(...) 时两者就不一样了。
   * 所以不擅自归一, 只钉住不许新增。 */
  'neox-spin', 'sfc-svc-spin', 'spin',
];

describe('@keyframes 全局命名空间', () => {
  it('测试确实扫到了 keyframes (自检)', () => {
    const all = collect();
    expect(all.size).toBeGreaterThan(200);
  });

  it('没有新的同名不同内容的 @keyframes', () => {
    const divergent = [...collect()]
      .filter(([, bodies]) => bodies.size > 1)
      .map(([name]) => name)
      .filter(n => !KNOWN_DIVERGENT.includes(n))
      .sort();
    expect(divergent,
      '@keyframes 是全局的, 同名多份时谁后加载谁通吃 —— 换个 @import 顺序动画就变了。' +
      `给它加个模块前缀: ${divergent.join(' / ')}`).toEqual([]);
  });

  it('已修好的 status-pulse 不许回来', () => {
    expect([...collect().keys()]).not.toContain('status-pulse');
  });
});
