import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mentionPathAddsInfo } from '../TimelineComposer';

describe('@ 菜单的路径列', () => {
  it('相对路径等于文件名 → 不显示 (实拍那几条)', () => {
    expect(mentionPathAddsInfo('a.md', 'a.md')).toBe(false);
    expect(mentionPathAddsInfo('agentboot-r1', 'agentboot-r1')).toBe(false);
    expect(mentionPathAddsInfo('__realtest-r1_testsnap.json', '__realtest-r1_testsnap.json')).toBe(false);
  });

  it('路径带目录 → 显示, 这才是它存在的理由', () => {
    expect(mentionPathAddsInfo('index.ts', 'src/ui/index.ts')).toBe(true);
    expect(mentionPathAddsInfo('a.md', 'docs/…/a.md')).toBe(true);
  });

  it('真描述 (@git / @codebase 那两条) 照常显示', () => {
    expect(mentionPathAddsInfo('@git', '当前分支与变更文件')).toBe(true);
    expect(mentionPathAddsInfo('@codebase', '工作区顶层结构摘要')).toBe(true);
  });

  it('空 / 只有空白 / 缺失一律不显示, 不许渲染出一行空副标题', () => {
    expect(mentionPathAddsInfo('a.md', '')).toBe(false);
    expect(mentionPathAddsInfo('a.md', '   ')).toBe(false);
    expect(mentionPathAddsInfo('a.md', undefined)).toBe(false);
    expect(mentionPathAddsInfo('a.md', null)).toBe(false);
  });

  it('首尾空白不算差别 —— 折过的路径可能带空白', () => {
    expect(mentionPathAddsInfo('a.md', ' a.md ')).toBe(false);
  });

  it('那一格即使空着也要留在 DOM 里 —— 抽掉它右边的角标会掉进 1fr', () => {
    /* 行是 `auto 1fr auto` 三列网格 (agent-timeline.css)。把中间那格条件渲染掉,
     * DIR / MD 角标会从右缘跑到名字边上。所以判断落在**内容**上, 不是落在 span 上。 */
    const HERE = dirname(fileURLToPath(import.meta.url));
    const tsx = readFileSync(resolve(HERE, '../TimelineComposer.tsx'), 'utf8');
    expect(tsx, 'span 被改成条件渲染了, 网格会塌')
      .toMatch(/<span className="atl-mention__path">\{showPath \? pathOrDesc : ''\}<\/span>/);
  });
});
