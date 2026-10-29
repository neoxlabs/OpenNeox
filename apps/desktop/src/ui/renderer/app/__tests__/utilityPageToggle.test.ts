import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../NeoxShellHost.tsx'), 'utf8');

function body(name: string): string {
  const i = SRC.search(new RegExp(`const ${name} = use(Callback|Event)\\(`));
  expect(i, `找不到 ${name}`).toBeGreaterThan(0);
  /* 截到这个 handler 自己的收尾 (`});` 或 `}, [deps]);`) —— 固定截 900 字会随注释长短漂进下一个函数 */
  const ends = [SRC.indexOf('\n  });', i), SRC.indexOf('\n  }, [', i)].filter((x) => x > 0);
  const end = Math.min(...ends);
  return SRC.slice(i, SRC.indexOf(');', end) + 2);
}

/** 这个 handler 是 useEvent 包的吗 —— useEvent 永远读最新值, 不存在依赖漏项。 */
function isUseEvent(name: string): boolean {
  return new RegExp(`const ${name} = useEvent\\(`).test(SRC);
}

const BROWSERS: Array<[string, string]> = [
  ['handleOpenSkills', 'skills'],
  ['handleOpenKnowledgeBase', 'knowledge'],
  ['handleOpenLibrary', 'library'],
  ['handleOpenPlugins', 'plugins'],
  ['handleOpenMcp', 'mcp'],
  ['handleOpenTeam', 'team'],
];

describe('浏览型入口都能再点一次退回', () => {
  it.each(BROWSERS)('%s 有退回分支', (fn, page) => {
    const b = body(fn);
    expect(b, `${fn} 缺少 agentPage === '${page}' 的退回分支`)
      .toMatch(new RegExp(`if \\(agentPage === '${page}'\\) \\{ setAgentPage\\('chat'\\); return; \\}`));
  });

  it.each(BROWSERS)('%s 读到的 agentPage 必须是最新值 —— 读旧值会让退回时灵时不灵', (fn) => {
    const b = body(fn);
    if (isUseEvent(fn)) {
      expect(b, `${fn} 用 useEvent 就不该再挂依赖数组`).not.toMatch(/\}, \[/);
      return;
    }
    const depsAt = b.indexOf('}, [');
    expect(depsAt).toBeGreaterThan(0);
    expect(b.slice(depsAt, depsAt + 160), `${fn} 依赖数组缺 agentPage`).toContain('agentPage');
  });
});

describe('图片工作台是刻意的例外', () => {
  it('不给它加退回 —— 带草稿的工作面, 手滑两下会丢东西', () => {
    const b = body('handleOpenImageStudio');
    expect(b, '图片工作台被顺手补上了退回分支; 若确实要改, 先想清楚未保存的 prompt 怎么办')
      .not.toMatch(/if \(agentPage === 'image'\) \{ setAgentPage\('chat'\)/);
  });

  it('这个例外在代码里留着理由 —— 没有理由的例外下次就会被"顺手补齐"', () => {
    const i = SRC.indexOf('const handleOpenImageStudio');
    const before = SRC.slice(Math.max(0, i - 900), i);
    expect(before).toMatch(/刻意不做|RELEASE_SCAN #60/);
  });
});
