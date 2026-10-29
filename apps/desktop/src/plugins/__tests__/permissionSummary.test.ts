import { describe, it, expect } from 'vitest';
import { summarizeComponents, summarizeConnectorPermissions, summarizePermissions } from '../permissionSummary';

/* notion 1.0.2 清单的形状 (删到够用) */
const notion = {
  permissions: { network: true },
  connector: {
    namespace: 'notion',
    permissions: [
      { capability: 'document.read', effect: 'readonly', reason: { en: 'Read pages', zh: '读取页面' } },
      { capability: 'document.create', effect: 'writes', reason: { en: 'Create pages', zh: '新建页面' } },
    ],
    tools: [{ name: 'read_page' }, { name: 'create_page' }],
  },
};

describe('permissionSummary', () => {
  it('英文界面全英文, 连接器的写能力标敏感, 只读不标', () => {
    expect([...summarizePermissions(notion.permissions, 'en'), ...summarizeConnectorPermissions(notion, 'en')]).toEqual([
      { text: 'Network access (HTTP)', sensitive: true },
      { text: 'Read pages [read-only]', sensitive: false },
      { text: 'Create pages [writes]', sensitive: true },
    ]);
    expect(summarizeComponents(notion, 'en')).toEqual(['Connector (notion · 2 agent tools)']);
  });

  it('中文界面取中文理由', () => {
    expect(summarizeConnectorPermissions(notion, 'zh').map((p) => p.text)).toEqual(['读取页面 [只读]', '新建页面 [写入]']);
  });
});
