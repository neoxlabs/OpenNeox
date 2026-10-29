import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

const BASELINE: Array<[string, number]> = [
  ['/modules/agent-timeline/cells/DiffView.tsx', 1],
  ['/pages/settings/tabs/SkillEditForm.tsx', 1],
];
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e) && !/\.test\.tsx$/.test(e)) out.push(p);
  }
  return out;
}
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** JSX 里一个元素的开标签 + 它直接包着的加载文案。 */
const LOADING_EL = /<(\w+)([^>]*)>\s*\{?[^<>{}]*(?:加载中…|加载中\.\.\.|载入中…|Loading…|Loading\.\.\.)/g;

function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const f of walk(ROOT)) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(LOADING_EL)) {
      if (/neox-text-shimmer|shimmer|skeleton/i.test(m[2] ?? '')) continue;
      const key = f.replace(ROOT, '').replace(/\\/g, '/');
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  return found;
}

describe('加载文案必须有 shimmer (棘轮)', () => {
  const found = scan();
  const base = new Map(BASELINE);

  it('没有新增的死加载文案', () => {
    const added: string[] = [];
    for (const [f, n] of found) {
      const allowed = base.get(f) ?? 0;
      if (n > allowed) added.push(`${f} (${allowed} → ${n})`);
    }
    expect(
      added,
      `新增了死的加载文案。加载文案要挂 .neox-text-shimmer, 不要把它补进基线: ${added.join(' / ')}`,
    ).toEqual([]);
  });

  it('基线里已经还掉的账不许再欠回来', () => {
    const total = [...found.values()].reduce((a, b) => a + b, 0);
    const baseTotal = BASELINE.reduce((a, [, n]) => a + n, 0);
    expect(total, '欠账总数只许减不许加').toBeLessThanOrEqual(baseTotal);
  });

  it('高频界面那几处已经还掉了 —— 它们是这条闸的起因', () => {
    const mustBeClean = [
      ['modules/shell/edition/AccountOverviewTab.tsx', 2],
      ['modules/shell/NotificationMenu.tsx', 1],
      ['modules/shell/RightPanel.tsx', 2],
      ['modules/explorer/components/FileExplorer.tsx', 1],
      ['modules/agent-timeline/TimelineComposer.tsx', 3],
      ['modules/agent-timeline/ComposerSurfaceDialogs.tsx', 1],
    ] as const;
    for (const [rel, n] of mustBeClean) {
      /* 前两个是商业目录/文件, 公开树里不存在 —— 不存在就没有这处欠账 */
      if (!existsSync(join(ROOT, rel))) continue;
      const src = readFileSync(join(ROOT, rel), 'utf8');
      const hits = [...src.matchAll(/neox-text-shimmer/g)].length;
      expect(hits, `${rel} 应当有 ${n} 处 shimmer`).toBeGreaterThanOrEqual(n);
      expect(found.get('/' + rel) ?? 0, `${rel} 不该还有死加载文案`).toBe(0);
    }
  });

  it('.neox-text-shimmer 的规范实现还在', () => {
    const css = readFileSync(
      join(ROOT, 'modules', 'agent-timeline', 'agent-timeline.css'), 'utf8');
    const block = /\.neox-text-shimmer\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
    expect(block).toMatch(/background-clip:\s*text/);
    expect(block).toMatch(/animation:\s*neox-text-shimmer-move/);
  });
});
