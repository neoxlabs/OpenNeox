import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

const known: Array<{ workspacePath: string }> = [];
vi.mock('@neoxlabs/core/platform/sessionStore.js', () => ({
  sessionStore: { listSessionsSlim: async () => known },
}));

import { ensureWorkspaceOpen } from '../openWorkspace.js';

function fakePm(openPaths: string[] = []) {
  const opened: string[] = [];
  return {
    opened,
    getByPath: (p: string) => (openPaths.includes(p) ? { workspacePath: p } : undefined),
    openProject: async (p: string) => { opened.push(p); },
  };
}

describe('ensureWorkspaceOpen', () => {
  beforeEach(() => { known.length = 0; });

  it('已经开着: 不再开, 返 false', async () => {
    const pm = fakePm(['/w/a']);
    expect(await ensureWorkspaceOpen(pm, '/w/a')).toBe(false);
    expect(pm.opened).toEqual([]);
  });

  it('桌面重启后没开着、但在最近会话里 → 自动打开 (手机挑项目开新会话不再失败)', async () => {
    known.push({ workspacePath: '/w/recent' });
    const pm = fakePm();
    expect(await ensureWorkspaceOpen(pm, '/w/recent')).toBe(true);
    expect(pm.opened).toEqual(['/w/recent']);
  });

  it('主目录下真实存在的文件夹 → 打开', async () => {
    const pm = fakePm();
    const home = os.homedir();
    expect(await ensureWorkspaceOpen(pm, home)).toBe(true);
    expect(pm.opened).toEqual([home]);
  });

  it('主目录之外 → 拒绝, 不打开', async () => {
    const pm = fakePm();
    await expect(ensureWorkspaceOpen(pm, path.parse(os.homedir()).root + 'etc')).rejects.toThrow('只能打开用户主目录下');
    expect(pm.opened).toEqual([]);
  });

  it('主目录下但不存在 → 拒绝', async () => {
    const pm = fakePm();
    await expect(ensureWorkspaceOpen(pm, path.join(os.homedir(), '__neox_no_such_dir__'))).rejects.toThrow();
    expect(pm.opened).toEqual([]);
  });
});
