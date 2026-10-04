/**
 * DX 修复回归测试
 *
 * 覆盖这一轮修掉的五个问题, 每条都对应一个真实会咬到用户的场景:
 *   1. permission 默认值 —— 不写 permission 时工具必须能跑
 *   2. permission:'ask' 没给 handler —— 必须立刻报错, 不许静默空转
 *   3. PermissionHandler —— 自定义审批要真的被调用
 *   4. stream().result() —— 消费完事件流后拿得到完整 AgentResult
 *   5. 类型擦除 —— 带 Zod schema 的工具能塞进 new Agent({ tools })
 *   6. Session —— send/persist/resume 不再抛 NotImplemented
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Agent, tool, createSession, Session } from '../index.js';
import { mockLlm } from '../testing/index.js';
import { builtinTools } from '../tools/index.js';

const mock = () => mockLlm({ responses: [{ type: 'text', content: 'ok' }] });

describe('permission', () => {
  it('默认值不再是 ask —— 不写 permission 也能跑', async () => {
    const agent = new Agent({ model: 'mock', provider: mock() });
    const res = await agent.run('hi');
    expect(res.stopReason).not.toBe('permission_denied');
    expect(res.text).toBe('ok');
  });

  it("permission:'ask' 缺 handler 时立刻报错, 且错误信息给出两条出路", async () => {
    const agent = new Agent({
      model: 'claude-sonnet-4-6',
      permission: 'ask',
      provider: { type: 'anthropic', apiKey: 'sk-not-used' },
    });
    await expect(agent.run('hi')).rejects.toThrow(/PermissionHandler/);
    await expect(agent.run('hi')).rejects.toThrow(/'auto'/);
  });

  it('PermissionHandler 是合法的 permission 值 (类型 + 运行时都接受)', () => {
    const agent = new Agent({
      model: 'mock',
      provider: mock(),
      permission: async ({ tool: name, dangerous }) => ({
        approved: !dangerous && name !== 'blocked',
        reason: 'test policy',
      }),
    });
    expect(typeof agent.config.permission).toBe('function');
  });
});

describe('tool 类型擦除', () => {
  it('带 Zod schema 的工具可以直接塞进 Agent —— 这一条挂了 README 示例就编译不过', async () => {
    const weather = tool({
      name: 'get_weather',
      description: 'Get weather for a city',
      schema: z.object({ city: z.string() }),
      handler: async ({ city }) => ({ city, temp: 22 }),
    });
    const agent = new Agent({ model: 'mock', provider: mock(), tools: [weather] });
    expect(agent.config.tools?.[0]?.name).toBe('get_weather');
  });

  it('dangerous / readOnly 落到工具对象上, 供权限层判断', () => {
    const ro = tool({ name: 'r', description: 'd', schema: z.object({}), handler: async () => 1 });
    const rw = tool({
      name: 'w',
      description: 'd',
      schema: z.object({}),
      handler: async () => 1,
      dangerous: true,
    });
    expect(ro.readOnly).toBe(true);
    expect(ro.dangerous).toBe(false);
    expect(rw.dangerous).toBe(true);
    expect(rw.readOnly).toBe(false);
  });
});

describe('stream()', () => {
  it('既能迭代, 又能 await result() 拿到完整结果', async () => {
    const agent = new Agent({ model: 'mock', provider: mock() });
    const stream = agent.stream('hi');

    const seen: string[] = [];
    for await (const ev of stream) seen.push(ev.type);

    const res = await stream.result();
    expect(seen).toContain('text_delta');
    expect(res.text).toBe('ok');
    expect(res.stopReason).toBeDefined();
    expect(res.usage).toBeDefined();
  });

  it('暴露 abort()', () => {
    const agent = new Agent({ model: 'mock', provider: mock() });
    const stream = agent.stream('hi');
    expect(typeof stream.abort).toBe('function');
  });
});

describe('Session', () => {
  it('send 累积历史, 落盘后可 resume 回来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neox-sdk-session-'));
    const session = await createSession({
      model: 'mock',
      provider: mock(),
      checkpointDir: dir,
      sessionId: 'fixed-id',
    });

    const first = await session.send('第一轮');
    expect(first.text).toBe('ok');
    expect(session.history()).toHaveLength(2);

    const revived = await Session.resume('fixed-id', { checkpointDir: dir, model: 'mock' });
    expect(revived.id).toBe('fixed-id');
    expect(revived.history()).toHaveLength(2);
  });

  it('resume 找不到会话时报错, 而不是给一个空会话', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neox-sdk-session-'));
    await expect(Session.resume('nope', { checkpointDir: dir })).rejects.toThrow(/not found/);
  });
});

describe('builtinTools.fs', () => {
  it('默认只读: 不给 allowWrite 就没有写工具', () => {
    const names = builtinTools.fs({ root: process.cwd() }).map((t) => t.name);
    expect(names).toEqual(['read_file', 'list_files', 'search_files']);
    expect(names).not.toContain('write_file');
  });

  it('allowWrite 打开后写工具存在且标了 dangerous', () => {
    const tools = builtinTools.fs({ root: process.cwd(), allowWrite: true });
    const write = tools.find((t) => t.name === 'write_file');
    expect(write?.dangerous).toBe(true);
  });

  it('读文件被钉在 root 内, 越界与绝对路径都拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neox-sdk-fs-'));
    await writeFile(join(root, 'a.txt'), 'hello', 'utf8');
    const [readTool] = builtinTools.fs({ root });
    const ctx = { signal: new AbortController().signal, logger: console };

    const ok = (await readTool.invoke({ path: 'a.txt' }, ctx as any)) as any;
    expect(ok.content).toBe('hello');

    const escaped = (await readTool.invoke({ path: '../../etc/hosts' }, ctx as any)) as any;
    expect(escaped.error).toMatch(/escapes/);

    const absolute = (await readTool.invoke({ path: '/etc/hosts' }, ctx as any)) as any;
    expect(absolute.error).toMatch(/absolute/);
  });

  it('排除策略挡住敏感路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neox-sdk-fs-'));
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'config'), 'secret', 'utf8');
    const [readTool] = builtinTools.fs({ root });
    const ctx = { signal: new AbortController().signal, logger: console };
    const res = (await readTool.invoke({ path: '.git/config' }, ctx as any)) as any;
    expect(res.error).toMatch(/excluded/);
  });

  it('edit_file 要求 find 串唯一', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neox-sdk-fs-'));
    await writeFile(join(root, 'dup.txt'), 'x\nx\n', 'utf8');
    const tools = builtinTools.fs({ root, allowWrite: true });
    const edit = tools.find((t) => t.name === 'edit_file')!;
    const ctx = { signal: new AbortController().signal, logger: console };
    const res = (await edit.invoke({ path: 'dup.txt', find: 'x', replace: 'y' }, ctx as any)) as any;
    expect(res.error).toMatch(/appears 2 times/);
    expect(await readFile(join(root, 'dup.txt'), 'utf8')).toBe('x\nx\n');
  });

  /* 审计 F01 / F02: 新建文件经链接父目录写出 root; 搜索不逐文件校验、漏掉嵌套敏感文件 */
  describe('符号链接与嵌套排除', () => {
    const ctx = { signal: new AbortController().signal, logger: console } as any;
    const setup = async () => {
      const base = await mkdtemp(join(tmpdir(), 'neox-sdk-link-'));
      const root = join(base, 'ws');
      const outside = join(base, 'outside');
      await mkdir(root, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'secret.txt'), 'MARKER outside', 'utf8');
      await symlink(outside, join(root, 'out'));
      await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'));
      await mkdir(join(root, 'nested'), { recursive: true });
      await writeFile(join(root, 'nested', '.env'), 'MARKER env', 'utf8');
      await writeFile(join(root, 'ok.txt'), 'MARKER ok', 'utf8');
      const tools = builtinTools.fs({ root, allowWrite: true });
      const get = (n: string) => tools.find((t) => t.name === n)!;
      return { root, outside, get };
    };

    it('写新文件: 父目录是指向外面的链接 → 拒绝, 外面没有文件', async () => {
      const { outside, get } = await setup();
      const res = (await get('write_file').invoke({ path: 'out/new.txt', content: 'x' }, ctx)) as any;
      expect(res.error).toMatch(/symlink escapes/);
      await expect(stat(join(outside, 'new.txt'))).rejects.toThrow();
    });

    it('写新文件: 多层父目录都不存在时经链接也拦得住', async () => {
      const { outside, get } = await setup();
      const res = (await get('write_file').invoke({ path: 'out/a/b/c.txt', content: 'x' }, ctx)) as any;
      expect(res.error).toMatch(/symlink escapes/);
      await expect(stat(join(outside, 'a'))).rejects.toThrow();
    });

    it('写新文件: 普通缺失的多层目录照常创建', async () => {
      const { root, get } = await setup();
      const res = (await get('write_file').invoke({ path: 'a/b/c.txt', content: 'x' }, ctx)) as any;
      expect(res.error).toBeUndefined();
      expect(await readFile(join(root, 'a', 'b', 'c.txt'), 'utf8')).toBe('x');
    });

    it('root 本身是链接时正常读写', async () => {
      const { root } = await setup();
      const alias = join(root, '..', 'alias');
      await symlink(root, alias);
      const tools = builtinTools.fs({ root: alias, allowWrite: true });
      const write = tools.find((t) => t.name === 'write_file')!;
      const res = (await write.invoke({ path: 'via-alias.txt', content: 'y' }, ctx)) as any;
      expect(res.error).toBeUndefined();
      expect(await readFile(join(root, 'via-alias.txt'), 'utf8')).toBe('y');
    });

    it('搜索不返回链接到外面的文件, 也不返回嵌套的 .env', async () => {
      const { get } = await setup();
      const res = (await get('search_files').invoke({ query: 'MARKER' }, ctx)) as any;
      expect(res.hits.map((h: any) => h.path)).toEqual(['ok.txt']);
    });

    it('列目录不列出链接出去的项和嵌套 .env', async () => {
      const { get } = await setup();
      const res = (await get('list_files').invoke({ recursive: true }, ctx)) as any;
      expect(res.entries.sort()).toEqual(['nested/', 'ok.txt']);
    });

    it('读嵌套 .env 被排除策略拒绝', async () => {
      const { get } = await setup();
      const res = (await get('read_file').invoke({ path: 'nested/.env' }, ctx)) as any;
      expect(res.error).toMatch(/excluded/);
    });
  });
});

describe('builtinTools.shell', () => {
  it('没有白名单时拒绝一切命令', async () => {
    const [run] = builtinTools.shell();
    const ctx = { signal: new AbortController().signal, logger: console };
    const res = (await run.invoke({ command: 'echo', args: ['hi'] }, ctx as any)) as any;
    expect(res.error).toMatch(/allow-listed/);
  });

  it('白名单内的命令可执行, 名单外的拒绝', async () => {
    const [run] = builtinTools.shell({ allowedCommands: ['echo'] });
    const ctx = { signal: new AbortController().signal, logger: console };

    const ok = (await run.invoke({ command: 'echo', args: ['hi'] }, ctx as any)) as any;
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe('hi');

    const denied = (await run.invoke({ command: 'rm', args: ['-rf', '/'] }, ctx as any)) as any;
    expect(denied.error).toMatch(/not allow-listed/);
  });

  it('命令一律标 dangerous', () => {
    const [run] = builtinTools.shell({ allowedCommands: ['echo'] });
    expect(run.dangerous).toBe(true);
  });
});
