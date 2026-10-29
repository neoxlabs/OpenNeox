import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');   // renderer/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

const blank = (m: string) => '\n'.repeat((m.match(/\n/g) ?? []).length);
const strip = (s: string) => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/^\s*\/\/.*$/gm, '');

/** try 块的真实 [start,end) —— 按花括号配对, 不是行窗口 */
function tryRanges(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of s.matchAll(/\btry\s*\{/g)) {
    let i = (m.index ?? 0) + m[0].length - 1, d = 0;
    for (; i < s.length; i++) {
      if (s[i] === '{') d++;
      else if (s[i] === '}') { d--; if (d === 0) break; }
    }
    out.push([m.index ?? 0, i]);
  }
  return out;
}

/** 只在**这一条语句**内找 .catch —— 固定字符窗口会被邻近无关的 .catch 蒙混:
 *  我做变异验证时把探针插在一个自带 .catch 的组件前面, 400 字符前瞻直接把它当成
 *  "有处理", 闸没红。按括号深度走到语句结束(depth 0 的 `;`)才算数。 */
function statementHasCatch(s: string, from: number): boolean {
  let depth = 1;                    // from 落在调用的 `(` 之后
  for (let i = from; i < s.length && i < from + 2000; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth < 0) return false;  // 出了外层作用域
    } else if (c === ';' && depth === 0) return false;
    if (depth === 0 && s.startsWith('.catch(', i)) return true;
  }
  return false;
}

/* `window.neox?.fn?.(` / `(window as any).neox.fn(` 都要认到 */
const CALL = /neox\s*\??\s*\.\s*(\w+)\s*\??\s*\.?\s*\(/g;
/* 事件订阅 / 无所谓成败的 fire-and-forget */
const SKIP = /^(on[A-Z]|off[A-Z]|uiState|markAuth|track|report|ping|stt|terminalWrite|terminalDestroy|runLaunch)/;
/* 用户主动触发 / 会改状态的动作 */
const ACTION = /^(create|open|export|import|delete|remove|save|apply|install|uninstall|search|git|service|kill|pause|resume|play|set[A-Z]|update|rename|move|copy|clone|push|pull|commit)/;

function scan() {
  const bad: string[] = [];
  const controls = { notifOpenExternal: false };
  for (const f of walk(ROOT)) {
    const s = strip(readFileSync(f, 'utf8'));
    if (!s.includes('neox')) continue;
    const trs = tryRanges(s);
    for (const m of s.matchAll(CALL)) {
      const name = m[1];
      const off = m.index ?? 0;
      const hasCatch = statementHasCatch(s, off + m[0].length);
      const inTry = trs.some(([a, b]) => a <= off && off < b);
      const rel = f.slice(ROOT.length);
      if (rel.endsWith('NotificationMenu.tsx') && name === 'openExternal') controls.notifOpenExternal = hasCatch;
      if (hasCatch || inTry) continue;
      if (SKIP.test(name) || !ACTION.test(name)) continue;
      bad.push(`${rel}:${s.slice(0, off).split('\n').length} neox.${name}()`);
    }
  }
  return { bad, controls };
}

const BASELINE = 18;

describe('用户操作的 IPC 失败反馈', () => {
  /* NotificationMenu 是商业文件, 公开树里没有这个对照样本 (下一条合成样本两边都在) */
  it.skipIf(!existsSync(join(__dirname, '..', 'modules/shell/NotificationMenu.tsx')))('对照样本: NotificationMenu.openExternal 有 .catch, 不该被报', () => {
    expect(scan().controls.notifOpenExternal,
      '匹配不到它 = 正则漏了 `?.(` 可选调用语法, 整个扫描不可信').toBe(true);
  });

  it('对照样本: try 在调用上方 40 行开外也要认得出', () => {
    const src = `async function run() {\n  try {\n${'    step();\n'.repeat(45)}    await window.neox?.searchContent?.(q);\n  } catch (e) { show(e); }\n}\nwindow.neox?.searchContent?.(q);\n`;
    const trs = tryRanges(src);
    const calls = [...src.matchAll(CALL)].map((m) => m.index ?? 0);
    expect(calls.length).toBe(2);
    expect(trs.some(([a, b]) => a <= calls[0] && calls[0] < b),
      '认不出它 = try 块判定退化成了行窗口, 整个扫描不可信').toBe(true);
    expect(trs.some(([a, b]) => a <= calls[1] && calls[1] < b), 'try 外的调用不该算进去').toBe(false);
  });

  it('无错误处理的用户操作只许减不许加', () => {
    const { bad } = scan();
    expect(bad.length,
      `新增了"用户点了、失败了、但什么都不显示"的调用。要么 .catch → dispatchOpFailed, `
      + `要么包在 try 里给用户看错误。当前: ${bad.slice(0, 6).join(' / ')}`,
    ).toBeLessThanOrEqual(BASELINE);
  });
});
