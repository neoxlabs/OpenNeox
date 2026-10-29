
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '../renderer/app/NeoxRuntimeBridge.tsx');

/** 确认稳定、不需要进 deps 的标识符。加之前先去源码确认它的定义。 */
const STABLE = new Set<string>([
  /* useState 的 setter —— React 保证同一性 */
  'setMode', 'setThinkingMode',
  /* useCallback([]) / useRef / 模块级常量 */
  'setEffortForModel', 'EMPTY_TIMELINE_FOR_CONTEXT',
]);

function extractValueMemo(src: string) {
  const lines = src.split('\n');
  const anchor = lines.findIndex((l) => /const value = useMemo</.test(l));
  expect(anchor, '没找到 `const value = useMemo<` —— 源码结构变了, 这条测试要跟着改')
    .toBeGreaterThan(-1);

  let i = anchor;
  while (i < lines.length && !lines[i]!.includes('({')) i++;
  const bodyStart = i + 1;
  /* deps 数组以单独一行的 `[` 开头 */
  let j = bodyStart;
  while (j < lines.length && lines[j]!.trim() !== '[') j++;
  expect(j, '没找到 deps 数组').toBeLessThan(lines.length);

  const body = lines.slice(bodyStart, j);
  const deps: string[] = [];
  let k = j + 1;
  for (; k < lines.length && lines[k]!.trim() !== '],'; k++) {
    const t = lines[k]!.trim().replace(/,$/, '');
    if (t && !t.startsWith('/*') && !t.startsWith('*') && !t.startsWith('//')) deps.push(t);
  }
  return { body, deps };
}

/** `key,` → key;  `key: expr` → expr 开头的完整成员表达式 (deps 里写的就是 `workspace.path`
 *  这种形式, 只取根标识符会把它误报成漏依赖)。 */
function referencedIdents(body: string[]): Array<{ key: string; ident: string }> {
  const out: Array<{ key: string; ident: string }> = [];
  for (const raw of body) {
    const t = raw.trim();
    if (!t || t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')) continue;
    const shorthand = t.match(/^([A-Za-z_$][\w$]*)\s*,\s*$/);
    if (shorthand) { out.push({ key: shorthand[1]!, ident: shorthand[1]! }); continue; }
    const renamed = t.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/);
    if (renamed) out.push({ key: renamed[1]!, ident: renamed[2]! });
  }
  return out;
}

describe('NeoxRuntimeBridge · context useMemo 依赖完整性', () => {
  const src = readFileSync(SRC, 'utf8');
  const { body, deps } = extractValueMemo(src);
  const depSet = new Set(deps);

  it('夹具有效性: 真的解析出了 value 键和 deps (否则整条是空跑)', () => {
    expect(referencedIdents(body).length).toBeGreaterThan(20);
    expect(deps.length).toBeGreaterThan(20);
  });

  it('value 里引用的每个标识符都在 deps 里 (或在稳定白名单中)', () => {
    const missing = referencedIdents(body)
      .filter(({ ident }) => !depSet.has(ident) && !STABLE.has(ident))
      .map(({ key, ident }) => (key === ident ? key : `${key} ← ${ident}`));
    expect(missing, [
      '这些标识符出现在 context value 里但不在 deps 数组中。',
      '漏依赖不会报错, 表现是"某个功能点了没反应" —— 见文件顶部的实拍案例。',
      '若确认它是稳定引用 (useCallback([]) / setState setter / 模块级常量),',
      '把它加进本文件的 STABLE 白名单; 否则请补进 deps。',
    ].join('\n')).toEqual([]);
  });

  it('推理强度那两个值必须在 deps 里 (回归钉子)', () => {
    expect(depSet.has('effortLevel'), 'effortLevel 漏了 → 强度选择器失灵').toBe(true);
    expect(depSet.has('effortByModel'), 'effortByModel 漏了 → 强度选择器失灵').toBe(true);
  });
});
