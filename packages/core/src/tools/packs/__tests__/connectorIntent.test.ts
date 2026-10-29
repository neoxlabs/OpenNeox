import { afterEach, describe, expect, it } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { collectConnectorToolsForPrompt } from '../connectorIntent.js';
import { filterToolsByAgentMode, toolPackRegistry } from '../toolPack.js';
import { ToolTreeEngine } from '../../toolTreeEngine.js';

function makeTool(name: string): Tool {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    function: async () => '',
  };
}

const GCAL = ['gcal_list_events', 'gcal_create_event', 'gcal_update_event'];

function registerGcal(): void {
  toolPackRegistry.register({
    id: 'connector:google-calendar',
    label: 'Google Calendar',
    icon: '🔌',
    description: 'Google Calendar connector tools for work and code modes',
    group: 'community',
    tier: 'extended',
    keywords: ['gcal', 'google-calendar', 'connector'],
    modes: ['work', 'code'],
    toolNames: GCAL,
    createTools: () => GCAL.map(makeTool),
  });
}

afterEach(() => {
  toolPackRegistry.unregisterByPrefix('connector:google-calendar');
});

describe('collectConnectorToolsForPrompt', () => {
  it('用户点名 gcal_* / google-calendar 就收回整包', () => {
    registerGcal();
    expect(collectConnectorToolsForPrompt('Use gcal_list_events from google-calendar')).toEqual(GCAL);
    expect(collectConnectorToolsForPrompt('pack google-calendar')).toEqual(GCAL);
    expect(collectConnectorToolsForPrompt('查一下谷歌日历')).toEqual(GCAL);
  });

  it('不相干的话不解锁', () => {
    registerGcal();
    expect(collectConnectorToolsForPrompt('tomorrow weather')).toEqual([]);
  });
});

describe('没有连接器接得住时预解锁插件商店 (2026-09-25)', () => {
  const registerStore = () => toolPackRegistry.register({
    id: 'plugin-store',
    label: '插件商店',
    icon: '🧩',
    description: 'Search installed plugins and the Neox plugin store',
    group: 'platform',
    tier: 'primary',
    toolNames: ['plugin_store_search'],
    createTools: () => [makeTool('plugin_store_search')],
  });
  afterEach(() => toolPackRegistry.unregisterByPrefix('plugin-store'));

  it('点名一个没装的服务 → 解锁 plugin_store_search', () => {
    registerStore();
    expect(collectConnectorToolsForPrompt('帮我看看 Jira 上分给我的工单')).toEqual(['plugin_store_search']);
    expect(collectConnectorToolsForPrompt('把这段发到飞书群里')).toEqual(['plugin_store_search']);
  });

  it('直接问插件 / 集成也解锁', () => {
    registerStore();
    expect(collectConnectorToolsForPrompt('有没有能接 Slack 的插件')).toEqual(['plugin_store_search']);
  });

  it('已装连接器接得住就只给连接器, 不多塞商店', () => {
    registerGcal();
    registerStore();
    expect(collectConnectorToolsForPrompt('google calendar 明天有什么会')).toEqual(GCAL);
  });

  it('普通的话不解锁; 宿主没注册商店包也不解锁', () => {
    registerStore();
    expect(collectConnectorToolsForPrompt('帮我把这个函数重构一下')).toEqual([]);
    toolPackRegistry.unregisterByPrefix('plugin-store');
    expect(collectConnectorToolsForPrompt('帮我看看 Jira')).toEqual([]);
  });

  it('词中间的子串不算点名 (steams ≠ teams)', () => {
    registerStore();
    expect(collectConnectorToolsForPrompt('the steams of data')).toEqual([]);
  });
});

describe('点名外部 agent 就预解锁它的委派工具', () => {
  afterEach(() => { toolPackRegistry.unregisterByPrefix('extagent:codex'); });
  const register = () => toolPackRegistry.register({
    id: 'extagent:codex', label: 'codex 外部 Agent', icon: '🤝', description: '委派给外部 Agent: Codex',
    group: 'agent', tier: 'extended', keywords: ['codex', 'delegate', 'external', 'agent'],
    toolNames: ['codex_delegate'], createTools: () => [makeTool('codex_delegate')],
  });

  it('说了 Codex → 解锁 codex_delegate', () => {
    register();
    expect(collectConnectorToolsForPrompt('让 Codex 在后台看一下 calc.py 有什么 bug')).toContain('codex_delegate');
  });

  it('按词点名: android 里的 droid 不算, 中文里紧挨着写的照样算 (2026-09-26)', () => {
    toolPackRegistry.register({
      id: 'extagent:droid', label: 'droid 外部 Agent', icon: '🤝', description: '委派给外部 Agent: Droid',
      group: 'agent', tier: 'extended', keywords: ['droid', 'delegate', 'external', 'agent'],
      toolNames: ['droid_delegate'], createTools: () => [makeTool('droid_delegate')],
    });
    try {
      expect(collectConnectorToolsForPrompt('帮我看看这个 android 项目的 gradle 配置')).not.toContain('droid_delegate');
      expect(collectConnectorToolsForPrompt('让droid把测试补上')).toContain('droid_delegate');
      expect(collectConnectorToolsForPrompt('Ask Droid to fix the build')).toContain('droid_delegate');
    } finally {
      toolPackRegistry.unregisterByPrefix('extagent:droid');
    }
  });

  it('只说 agent / delegate 这类泛词 → 不解锁', () => {
    register();
    expect(collectConnectorToolsForPrompt('派个 agent 去查一下, delegate 给别人也行')).not.toContain('codex_delegate');
  });
});

describe('连接器在 Work / Code 可见', () => {
  it('filterToolsByAgentMode 两个模式都留 gcal', () => {
    registerGcal();
    const tools = GCAL.map(makeTool);
    for (const mode of ['work', 'code'] as const) {
      const kept = filterToolsByAgentMode(tools, mode).map((t) => t.name);
      expect(kept, mode).toEqual(GCAL);
    }
  });

  it('tool_search 按短名和关键词都能命中', async () => {
    registerGcal();
    const engine = new ToolTreeEngine([makeTool('readfile')], {
      alwaysActive: new Set(['readfile']),
    });
    const search: any = engine.liveTools.find((t) => t.name === 'tool_search');
    const byPack = String(await search.function({ pack: 'google-calendar' }));
    expect(byPack).toContain('gcal_list_events');
    const byQuery = String(await search.function({ query: 'gcal' }));
    expect(byQuery).toContain('gcal_create_event');
  });
});
