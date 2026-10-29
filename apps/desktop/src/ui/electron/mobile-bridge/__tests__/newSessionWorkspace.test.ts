import { describe, it, expect } from 'vitest';
import { resolveNewSessionScope } from '../newSessionWorkspace';

function fakePm(open: string[] = []) {
  const opened = new Set(open);
  return {
    opened,
    getByPath: (p: string) => (opened.has(p) ? { workspacePath: p } : undefined),
    getFocused: () => (opened.size ? { workspacePath: [...opened][0] } : undefined),
    openProject: async (p: string) => { opened.add(p); },
  };
}

const store = {
  listSessionsSlim: async () => [
    { workspacePath: '/old', updatedAt: 1 },
    { workspacePath: '/recent', updatedAt: 9 },
    { workspacePath: '', updatedAt: 99 },
  ],
};

describe('resolveNewSessionScope', () => {
  it('一个项目都没开 → 打开最近用过的工作区并用它', async () => {
    const pm = fakePm();
    const scope = await resolveNewSessionScope(pm, store);
    expect(scope?.workspacePath).toBe('/recent');
    expect(pm.opened.has('/recent')).toBe(true);
  });

  it('有打开的项目 → 直接用, 不另开', async () => {
    const pm = fakePm(['/current']);
    expect((await resolveNewSessionScope(pm, store))?.workspacePath).toBe('/current');
    expect(pm.opened.size).toBe(1);
  });

  it('指定了目录但没打开 → 打开它', async () => {
    const pm = fakePm();
    expect((await resolveNewSessionScope(pm, store, '/proj'))?.workspacePath).toBe('/proj');
  });

  it('从没用过任何项目 → null (调用方报人话)', async () => {
    expect(await resolveNewSessionScope(fakePm(), { listSessionsSlim: async () => [] })).toBeNull();
  });
});
