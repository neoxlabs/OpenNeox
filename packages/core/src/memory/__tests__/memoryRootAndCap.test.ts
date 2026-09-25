/**
 * 记忆的根在哪 + 动态注入的上限。
 *
 * 这两件事的失效都是**静默的**: 记忆根找错了, 表现是"模型好像不知道项目约定";
 * 注入没有上限, 表现是上下文越跑越长。两个都不会报错。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMemoryRoot } from '../projectMemoryV2.js';
import { DynamicContextInjector } from '../dynamicInjector.js';

let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'neox-mem-'))); });
afterEach(() => { try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } });

function touch(rel: string, body = 'x'): void {
  const p = join(base, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
}

describe('resolveMemoryRoot', () => {
  it('从子目录往上找得到仓库根的 .neox/project.md', () => {
    touch('repo/.neox/project.md', '# 项目约定');
    mkdirSync(join(base, 'repo/packages/foo'), { recursive: true });
    expect(resolveMemoryRoot(join(base, 'repo/packages/foo'), base)).toBe(join(base, 'repo'));
  });

  it('NEOX.md 也算 (向后兼容)', () => {
    touch('repo/NEOX.md', '# 老格式');
    mkdirSync(join(base, 'repo/src'), { recursive: true });
    expect(resolveMemoryRoot(join(base, 'repo/src'), base)).toBe(join(base, 'repo'));
  });

  it('没有记忆文件时退到 git 仓库根', () => {
    touch('repo/.git/HEAD', 'ref: refs/heads/main');
    mkdirSync(join(base, 'repo/a/b'), { recursive: true });
    expect(resolveMemoryRoot(join(base, 'repo/a/b'), base)).toBe(join(base, 'repo'));
  });

  it('子包自己有 .neox 时它赢 —— monorepo 里近的那份更准', () => {
    touch('repo/.neox/project.md', '根');
    touch('repo/.git/HEAD', 'ref');
    touch('repo/packages/foo/.neox/project.md', '子包');
    expect(resolveMemoryRoot(join(base, 'repo/packages/foo'), base)).toBe(join(base, 'repo/packages/foo'));
  });

  it('**走到 home 就停** —— ~/.neox 是应用自己的数据目录, 不是项目记忆', () => {
    /* 把 base 当成 home: 它下面放一个 .neox/project.md 模拟 ~/.neox */
    touch('.neox/project.md', '这是用户目录, 不该被当成项目记忆');
    mkdirSync(join(base, 'somewhere/deep'), { recursive: true });
    expect(resolveMemoryRoot(join(base, 'somewhere/deep'), base)).toBe(join(base, 'somewhere/deep'));
  });

  it('什么都没有就是 workDir 自己', () => {
    mkdirSync(join(base, 'plain'), { recursive: true });
    expect(resolveMemoryRoot(join(base, 'plain'), base)).toBe(join(base, 'plain'));
  });
});

/** 只需要 upsertSystemTagged 这一个方法 */
function fakeMemory(): { text: string; upsertSystemTagged(tag: string, body: string): void } {
  return { text: '', upsertSystemTagged(_t: string, body: string) { this.text = body; } };
}

describe('DynamicContextInjector 的上限', () => {
  function injectorWithModules(count: number, chars = 50) {
    const modules = new Map<string, string>();
    for (let i = 0; i < count; i++) modules.set(`m${i}`, 'x'.repeat(chars));
    const memory = fakeMemory();
    const inj = new DynamicContextInjector({
      memory: memory as never,
      memoryV2: { root: '/w', project: null, projectSource: null, modules, rules: new Map() },
      workDir: '/w',
    });
    return { inj, memory };
  }

  it('条数到顶就挤掉最久没碰的, 不是拒绝新的', () => {
    const { inj, memory } = injectorWithModules(20);
    for (let i = 0; i < 20; i++) inj.onToolCall('read_file', { file_path: `/w/m${i}/a.ts` });
    const sections = memory.text.split('\n\n').filter(Boolean);
    expect(sections.length).toBeLessThanOrEqual(12);
    /* 最新的那个必须在 —— 模型正在看的文件, 它的上下文最该留着 */
    expect(memory.text).toContain('m19');
    expect(memory.text).not.toContain('模块上下文: m0\n');
  });

  it('字符数到顶也挤 —— 它是每一次请求都要发出去的', () => {
    const { inj, memory } = injectorWithModules(10, 4000);
    for (let i = 0; i < 10; i++) inj.onToolCall('read_file', { file_path: `/w/m${i}/a.ts` });
    expect(memory.text.length).toBeLessThanOrEqual(12_000 + 200);
  });

  it('被挤掉的模块之后还能再收进来 —— 淘汰是"先放一放"不是"永久拉黑"', () => {
    const { inj, memory } = injectorWithModules(20);
    for (let i = 0; i < 20; i++) inj.onToolCall('read_file', { file_path: `/w/m${i}/a.ts` });
    expect(memory.text).not.toContain('模块上下文: m0\n');
    inj.onToolCall('read_file', { file_path: '/w/m0/a.ts' });
    expect(memory.text).toContain('m0');
  });
});
