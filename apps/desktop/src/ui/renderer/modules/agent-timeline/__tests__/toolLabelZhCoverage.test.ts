import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';


const ROOT = path.resolve(__dirname, '../../../../../../../..');
const MAP = path.resolve(__dirname, '../mapTimeline.ts');
const EXTRA = path.resolve(__dirname, '../toolLabelMaps.ts');

function zhLabelKeys(): Set<string> {
  const keys = new Set<string>();
  for (const [file, name] of [[MAP, 'CODE_TOOL_LABEL_ZH'], [EXTRA, 'CODE_TOOL_LABEL_ZH_EXTRA']] as const) {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(new RegExp(`const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`));
    if (!m) throw new Error(`没找到 ${name}`);
    for (const x of m[1]!.matchAll(/^\s*([a-z_0-9]+)\s*:/gm)) keys.add(x[1]!);
  }
  return keys;
}

/** 从 neox-core 的工具注册表里抓出所有注册过的工具名 */
function registeredTools(): string[] {
  const dir = path.join(ROOT, 'packages/core/src/tools');
  if (!fs.existsSync(dir)) return [];
  const names = new Set<string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); continue; }
      if (!e.name.endsWith('.ts')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/name:\s*'([a-z][a-z_0-9]{2,})'/g)) names.add(m[1]!);
    }
  };
  walk(dir);
  return [...names];
}

/* 这些不是给用户看的工具行, 或者本来就是英文专名, 不要求中文名 */
const EXEMPT = new Set(['some_new_tool', 'xxx', 'api', 'backend', 'web', 'memory', 'browser']);

describe('中文工具名覆盖', () => {
  it('注册过的工具都要有中文名, 否则中文界面会露出英文', () => {
    const zh = zhLabelKeys();
    const tools = registeredTools();
    expect(tools.length).toBeGreaterThan(50); // 抓取本身没坏

    const missing = tools.filter((t) => !zh.has(t) && !EXEMPT.has(t)).sort();
    expect(missing, `以下工具没有中文名, 会在中文界面里显示成英文:\n  ${missing.join('\n  ')}`).toEqual([]);
  });
});
