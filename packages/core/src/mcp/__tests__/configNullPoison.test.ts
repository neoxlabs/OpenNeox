import { describe, expect, it, vi } from 'vitest';

vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { keepValidServers, addMcpServer } = await import('../configStore.js');

describe('读取端: 坏条目不该毁掉整个列表', () => {
  it('null / undefined / 非对象 / 缺 id / 空白 id 全被挑掉, 好的照常留下', () => {
    const kept = keepValidServers([
      null,
      undefined,
      'not-an-object',
      42,
      { command: 'x' },
      { id: '   ' },
      { id: 'good-one', command: 'node' },
      { id: 'another', url: 'http://x' },
    ]);
    expect(kept.map((s) => s.id)).toEqual(['good-one', 'another']);
  });

  it('整个 servers 字段就是 null 时返回空数组, 不抛', () => {
    expect(keepValidServers(null)).toEqual([]);
    expect(keepValidServers(undefined)).toEqual([]);
    expect(keepValidServers({ nonsense: true })).toEqual([]);
  });

  it('全是坏条目时返回空数组 —— 不抛, 界面还能用', () => {
    expect(keepValidServers([null, null, {}])).toEqual([]);
  });
});

describe('写入端: 别让坏东西进配置文件', () => {
  it('null 当场拒绝', () => {
    expect(() => addMcpServer('/tmp', 'user', null as never)).toThrow(/必须是对象|null/);
  });

  it('缺 id 当场拒绝', () => {
    expect(() => addMcpServer('/tmp', 'user', { command: 'node' } as never)).toThrow(/id/);
  });

  it('空白 id 也算缺', () => {
    expect(() => addMcpServer('/tmp', 'user', { id: '   ' } as never)).toThrow(/id/);
  });
});
