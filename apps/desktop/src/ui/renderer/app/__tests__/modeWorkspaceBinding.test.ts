import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveEffectiveAgentMode,
  resolveNewSessionWorkspace,
  shouldKeepActiveSessionOnWorkspaceChange,
  hasModeHome,
  normalizeAgentMode,
  isModeHomePath,
  rememberCodeWorkspace,
  takeCodeWorkspace,
  fallbackCodeWorkspace,
  shouldKeepActiveSession,
} from '../modeWorkspaceBinding';

describe('shouldKeepActiveSession (切工作区没有 lastSession 时别拉空)', () => {
  const store: Record<string, string> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as any).window = { localStorage: { getItem: (k: string) => store[k] ?? null } };
  });
  const sessions = [{ id: 'a', workspacePath: '/proj/text' }, { id: 'b', workspacePath: '/proj/shell' }];

  it('刚在侧栏选中的会话属于新工作区 → 保留 (否则要点第二次)', () => {
    expect(shouldKeepActiveSession('a', sessions, '/proj/text/')).toBe(true);
  });
  it('活跃会话属于别的工作区 / 没有活跃会话 → 拉空', () => {
    expect(shouldKeepActiveSession('b', sessions, '/proj/text')).toBe(false);
    expect(shouldKeepActiveSession(null, sessions, '/proj/text')).toBe(false);
  });
  it('有 pending 新建 / 选中标记 → 保留', () => {
    store['neox-pending-select-session'] = '{"id":"x","ts":1}';
    expect(shouldKeepActiveSession('b', sessions, '/proj/text')).toBe(true);
    delete store['neox-pending-select-session'];
    store['neox-pending-new-session'] = '1';
    expect(shouldKeepActiveSession(null, sessions, '/proj/text')).toBe(true);
  });
});

const CODE_PROJECT = '/Users/me/AI/OpenNeox';
const WORK_HOME = '/Users/me/Documents/Neox/工作';

describe('resolveEffectiveAgentMode', () => {
  it('会话模式优先于全局默认', () => {
    expect(resolveEffectiveAgentMode({
      sessionAgentMode: 'work',
      ambientDefault: 'code',
    })).toBe('work');
  });

  it('没有会话模式时回落全局默认', () => {
    expect(resolveEffectiveAgentMode({ ambientDefault: 'work' })).toBe('work');
  });

  it('已下线的 Life (assistant) 一律按 Work 算 —— 存量会话/配置已并进 Work', () => {
    expect(resolveEffectiveAgentMode({ sessionAgentMode: 'assistant', ambientDefault: 'code' })).toBe('work');
    expect(resolveEffectiveAgentMode({ sessionAgentMode: null, ambientDefault: 'assistant' })).toBe('work');
  });

  it('全都没有时回落 code', () => {
    expect(resolveEffectiveAgentMode({})).toBe('code');
    expect(resolveEffectiveAgentMode({ sessionAgentMode: 'bogus', ambientDefault: 'nonsense' })).toBe('code');
  });

  it('图片会话跨模式 — 不代表当前模式, 回落全局默认', () => {
    expect(resolveEffectiveAgentMode({
      sessionAgentMode: 'work',
      sessionKind: 'image',
      ambientDefault: 'code',
    })).toBe('code');
  });
});

describe('normalizeAgentMode / hasModeHome', () => {
  it('归一: assistant→work, 非法值→code', () => {
    expect(normalizeAgentMode(undefined)).toBe('code');
    expect(normalizeAgentMode('life')).toBe('code');
    expect(normalizeAgentMode('assistant')).toBe('work');
    expect(normalizeAgentMode('work')).toBe('work');
  });

  it('只有 work 有 mode home', () => {
    expect(hasModeHome('work')).toBe(true);
    expect(hasModeHome('code')).toBe(false);
  });
});

describe('resolveNewSessionWorkspace', () => {
  it('BUG 回归: work 下新建会话绑 work home 而不是代码项目', () => {
    expect(resolveNewSessionWorkspace({
      effectiveMode: 'work',
      currentWorkspacePath: CODE_PROJECT,
      modeHomePath: WORK_HOME,
    })).toBe(WORK_HOME);
  });

  it('code 模式沿用当前项目根', () => {
    expect(resolveNewSessionWorkspace({
      effectiveMode: 'code',
      currentWorkspacePath: CODE_PROJECT,
      modeHomePath: null,
    })).toBe(CODE_PROJECT);
  });

  it('图片会话跟模式正交 — 永远沿用当前工作区', () => {
    expect(resolveNewSessionWorkspace({
      effectiveMode: 'work',
      kind: 'image',
      currentWorkspacePath: CODE_PROJECT,
      modeHomePath: WORK_HOME,
    })).toBe(CODE_PROJECT);
  });

  it('mode home 解析不出来时退回当前工作区, 不产出空路径', () => {
    expect(resolveNewSessionWorkspace({
      effectiveMode: 'work',
      currentWorkspacePath: CODE_PROJECT,
      modeHomePath: null,
    })).toBe(CODE_PROJECT);
    expect(resolveNewSessionWorkspace({
      effectiveMode: 'work',
      currentWorkspacePath: CODE_PROJECT,
      modeHomePath: '',
    })).toBe(CODE_PROJECT);
  });
});

describe('shouldKeepActiveSessionOnWorkspaceChange', () => {
  it('会话路径已匹配新工作区 → 幂等早退', () => {
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: 's1',
      activeSessionWorkspacePath: WORK_HOME,
      nextWorkspacePath: WORK_HOME,
    })).toBe(true);
  });

  it('用户切到别的项目 → 不保留, 走 lastSession 恢复', () => {
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: 's1',
      activeSessionWorkspacePath: CODE_PROJECT,
      nextWorkspacePath: '/Users/me/other-project',
    })).toBe(false);
  });

  it('没有活跃会话时不保留', () => {
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: null,
      activeSessionWorkspacePath: null,
      nextWorkspacePath: WORK_HOME,
    })).toBe(false);
  });
});

describe('切回 code 还原上一个项目', () => {
  const store = new Map<string, unknown>();
  beforeEach(() => {
    store.clear();
    (globalThis as any).window = {
      neox: {
        uiStateGet: async (k: string) => store.get(k) ?? null,
        uiStateSet: async (k: string, v: unknown) => { store.set(k, v); },
      },
    };
  });

  it('离开 code 记下项目, 切回来还原它', async () => {
    await rememberCodeWorkspace(CODE_PROJECT, [WORK_HOME]);
    expect(await takeCodeWorkspace(WORK_HOME)).toBe(CODE_PROJECT);
  });

  it('已经在那个项目里就不再切 (幂等, 不白刷一次工作区)', async () => {
    await rememberCodeWorkspace(CODE_PROJECT, [WORK_HOME]);
    expect(await takeCodeWorkspace(CODE_PROJECT)).toBeNull();
  });

  it('mode home 不当项目记', async () => {
    await rememberCodeWorkspace(CODE_PROJECT, [WORK_HOME]);
    await rememberCodeWorkspace(WORK_HOME, [WORK_HOME]);
    expect(await takeCodeWorkspace(WORK_HOME)).toBe(CODE_PROJECT);
  });

  it('从没记过 → null (不猜, 停在当前工作区)', async () => {
    expect(await takeCodeWorkspace(WORK_HOME)).toBeNull();
  });

  it('isModeHomePath 认得 mode home, 认不出普通项目', () => {
    expect(isModeHomePath(WORK_HOME, [WORK_HOME])).toBe(true);
    expect(isModeHomePath(CODE_PROJECT, [WORK_HOME])).toBe(false);
    expect(isModeHomePath(null, [WORK_HOME])).toBe(false);
  });
});

/* 存量用户的那一格 —— "以后会记了"救不了已经卡住的人。 */
describe('fallbackCodeWorkspace — 从没记过项目的存量用户', () => {
  beforeEach(() => {
    (globalThis as any).window = {
      neox: {
        getLastState: async () => ({
          workspaces: [
            { path: '__time__today' },   /* 旧侧栏伪键, 不是工作区 */
            { path: WORK_HOME },         /* mode home 不是"项目" */
            { path: CODE_PROJECT },
          ],
        }),
      },
    };
  });

  it('困在 mode home 里 → 用最近的真项目兜底', async () => {
    expect(await fallbackCodeWorkspace(WORK_HOME, [WORK_HOME])).toBe(CODE_PROJECT);
  });

  it('人本来就待在自己项目里 → 不兜底 (不许乱切工作区)', async () => {
    expect(await fallbackCodeWorkspace('/Users/me/AI/other-project', [WORK_HOME])).toBeNull();
  });

  it('最近列表里全是 mode home / 伪键 → 停在原地', async () => {
    (globalThis as any).window.neox.getLastState = async () => ({
      workspaces: [{ path: '__time__today' }, { path: WORK_HOME }],
    });
    expect(await fallbackCodeWorkspace(WORK_HOME, [WORK_HOME])).toBeNull();
  });
});
