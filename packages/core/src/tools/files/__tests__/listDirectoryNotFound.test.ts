/**
 * A missing directory reports the nearest existing ancestor and its children
 * so the caller can correct the path from one result.
 *
 * The result identifies which path prefix exists and exposes its immediate
 * entries instead of returning only a raw ENOENT message.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { createListDirectoryTool } from '../directoryTools.js';

let root = '';

/** 只允许工作区内 —— 跟真实 resolveWorkspacePath 同语义 (越界抛错) */
const makeDeps = () => ({
  resolveWorkspacePath: (p = '.') => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
    if (abs !== root && !abs.startsWith(root + '/')) throw new Error('outside workspace');
    return abs;
  },
  formatDisplayPath: (abs: string) => abs.replace(root, '<ws>'),
});

const run = (directory: string) =>
  (createListDirectoryTool(makeDeps()).function as (a: any) => Promise<string>)({ directory });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'neox-listdir-'));
  mkdirSync(join(root, 'src', 'assets', 'icons'), { recursive: true });
  mkdirSync(join(root, 'src', 'assets', 'images'), { recursive: true });
  writeFileSync(join(root, 'src', 'assets', 'logo.png'), 'x');
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('list_directory 找不到时给的是线索, 不是一句 ENOENT', () => {
  it('猜错最后一段: 直接把父目录里真实有什么列出来', async () => {
    const out = await run('src/assets/svg');            /* 用户那条的形状 */
    expect(out).toContain('目录不存在');
    /* 关键: 断在哪一层 + 那一层实际有什么, 模型据此一次就能选对 */
    expect(out).toContain('最近存在的上级是');
    expect(out).toContain('icons/');
    expect(out).toContain('images/');
    expect(out).toContain('logo.png');
    /* 明确要求它别再拼路径 —— 这句是给模型的指令 */
    expect(out).toContain('不要继续拼路径');
    /* 不再把 Node 的原始异常甩出去 */
    expect(out).not.toContain('ENOENT');
    expect(out).not.toContain('scandir');
  });

  it('连错好几层也能往上找到最近那个真实存在的', async () => {
    const out = await run('src/assets/svg/foo/bar/baz');
    expect(out).toContain('最近存在的上级是');
    expect(out).toContain('icons/');
  });

  it('⚠️ 绝不借这条路径把工作区外面的目录内容漏出去', async () => {
    /* 越界请求在**第一行** resolveWorkspacePath 就被挡下 (那个错没有 ENOENT code),
     * 所以走通用分支如实说"越界", 而不是含糊地说"目录不存在" —— 更准确, 也压根
     * 到不了往上爬那一步。关键断言是: 任何情况下都不能吐出工作区外的目录内容。 */
    const out = await run('../../../../etc/definitely-not-here');
    expect(out).toContain('outside workspace');
    expect(out).not.toContain('最近存在的上级是');
  });

  it('⚠️ 往上爬本身也不许越界: 从工作区根再往上一层就停', async () => {
    /* 工作区根下一个不存在的目录 —— 往上第一步就是根 (合法, 会列出来),
     * 再往上就是根的父目录, resolveWorkspacePath 会抛, 循环必须就此停住。 */
    const out = await run('definitely-not-here-9f3a');
    expect(out).toContain('目录不存在');
    /* 列出的是工作区根的内容, 绝不含系统盘上的东西 */
    expect(out).toContain('src/');
    expect(out).not.toContain('/etc');
    expect(out).not.toContain('Users');
  });

  it('存在的目录照常正常列出 (没被这条 catch 改坏)', async () => {
    const out = await run('src/assets');
    expect(out).toContain('✓ 目录');
    expect(out).toContain('icons/');
  });
});
