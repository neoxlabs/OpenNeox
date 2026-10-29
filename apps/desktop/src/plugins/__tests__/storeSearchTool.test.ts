import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchPluginStore, queryTerms, resetStoreCatalogMemo } from '../storeSearchTool.js';

const CATALOG = {
  plugins: [
    { name: 'linear', version: '1.0.2', description: 'Search, read, and create Linear issues', descriptionZh: '搜索、读取、新建 Linear Issue', kind: 'connector', facets: ['connect'], keywords: ['linear', 'issues', 'tickets'], official: true },
    { name: 'office-kit', version: '1.0.0', description: 'Weekly reports, meeting minutes', descriptionZh: '周报、会议纪要、表格、论文', kind: 'skill', keywords: ['weekly-report', 'office'], official: true },
    { name: 'notion', version: '1.0.2', description: 'Read and write Notion pages', kind: 'connector', keywords: ['notion', 'docs'], official: true },
  ],
};

const installed = [
  { name: 'notion', version: '1.0.2', enabled: true, manifest: { description: 'Read and write Notion pages', keywords: ['notion'] } },
  { name: 'google-calendar', version: '1.0.0', enabled: false, manifest: { description: 'Google Calendar events', keywords: ['calendar'] } },
] as any[];

const deps = (base: string | null = 'https://store.test/api/v1') => ({ listInstalled: () => installed, storeBase: () => base ?? undefined });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetStoreCatalogMemo();
  fetchMock = vi.fn(async () => new Response(JSON.stringify(CATALOG), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('plugin_store_search', () => {
  it('商店有、没装: 给出 neox://plugins 链接', async () => {
    const r: any = await searchPluginStore('Linear 上的工单', deps());
    expect(r.store).toBe('available');
    expect(r.notInstalled.map((p: any) => p.name)).toEqual(['linear']);
    expect(r.notInstalled[0].link).toBe('neox://plugins/linear');
    expect(r.notInstalled[0].description).toBe('搜索、读取、新建 Linear Issue'); // 中文提问给中文描述
    expect(r.guidance).toMatch(/neox:\/\/plugins/);
  });

  it('已装的不重复出现在「没装」里, 状态带出来 (含已停用)', async () => {
    const a: any = await searchPluginStore('notion', deps());
    expect(a.installed).toEqual([expect.objectContaining({ name: 'notion', status: 'installed' })]);
    expect(a.notInstalled).toEqual([]);
    const b: any = await searchPluginStore('calendar', deps());
    expect(b.installed[0]).toMatchObject({ name: 'google-calendar', status: 'installed_but_disabled' });
  });

  it('都没有: 明说, 并且叫它别去本机找凭据', async () => {
    const r: any = await searchPluginStore('帮我看看 Jira 上分给我的工单', deps());
    expect(r.installed).toEqual([]);
    expect(r.notInstalled).toEqual([]);
    expect(r.guidance).toMatch(/Do not look for credentials/);
  });

  it('点了名 (Jira) 但商店没有: 靠「工单」蹭上的 Linear 只算相近, 不算答案', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      plugins: [{ ...CATALOG.plugins[0], descriptionZh: '搜索、读取、新建 Linear 工单' }],
    }), { status: 200 }));
    const r: any = await searchPluginStore('帮我看看 Jira 上分给我的工单', deps());
    expect(r.notInstalled).toEqual([]);
    expect(r.related.map((p: any) => p.name)).toEqual(['linear']);
    expect(r.guidance).toMatch(/Nothing in the Neox plugin store is for "jira"/);
  });

  it('整句里的关键词也能命中 (服务端 ?q= 只做单子串匹配, 这里拆词)', async () => {
    const r: any = await searchPluginStore('帮我写周报', deps());
    expect(r.notInstalled.map((p: any) => p.name)).toContain('office-kit');
  });

  it('没有商店地址 = 这个发行版没商店, 不打网络, 如实说', async () => {
    const r: any = await searchPluginStore('linear', deps(null));
    expect(r.store).toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('商店连不上 ≠ 商店里没有', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('bad gateway', { status: 502 }));
    const r: any = await searchPluginStore('linear', deps());
    expect(r.store).toBe('unreachable');
    expect(r.notInstalled).toBeUndefined();
  });

  it('5 分钟内重复查询不重复打网络', async () => {
    await searchPluginStore('linear', deps());
    await searchPluginStore('notion', deps());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('queryTerms 去掉停用词, 保留中英文词', () => {
    expect(queryTerms('帮我 连接 Slack 消息')).toEqual(['slack', '消息']);
  });
});
