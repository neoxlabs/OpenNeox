
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const credentials = new Map<string, any>();
const grants = new Map<string, Set<string>>();
const remembered = new Map<string, Set<string>>();

vi.mock('../connector/credentialStore.js', () => ({
  loadCredential: async (name: string) => credentials.get(name) ?? null,
  saveCredential: async (name: string, cred: any) => { credentials.set(name, cred); },
  deleteCredential: async (name: string) => { credentials.delete(name); },
  hasCredential: async (name: string) => credentials.has(name),
  getConnection: async () => ({}),
  setConnection: async () => {},
  clearConnection: async () => {},
}));

vi.mock('../connector/grantStore.js', () => ({
  grantStore: {
    isGranted: (id: string, cap: string) => grants.get(id)?.has(cap) ?? false,
    isRemembered: (id: string, cap: string) => remembered.get(id)?.has(cap) ?? false,
    remember: (id: string, cap: string) => {
      const set = remembered.get(id) ?? new Set<string>();
      set.add(cap);
      remembered.set(id, set);
    },
  },
  budgetStore: { remainingUsd: () => Infinity, charge: () => {} },
  setGrants: (id: string, caps: string[]) => { grants.set(id, new Set(caps)); },
  getGrants: (id: string) => [...(grants.get(id) ?? [])],
  revokeGrants: (id: string) => { grants.delete(id); },
  setBudget: () => {},
  getBudgetState: () => ({ spentUsd: 0 }),
  newPermissionsSince: () => [],
}));

const { connectorRegistry } = await import('../connector/connectorRegistry.js');
const { validateConnector } = await import('../connector/validate.js');

// ============================================================================
// Fixture: 官方 figma / notion 清单的**结构副本**
//
//   官方插件已经搬出主仓 (见 ~/code/neox-plugins) —— 主仓只负责架构, 插件是
//   独立分发物。所以这里不能再去读 examples/plugins。
//
//   留在这里的是清单的形状而不是内容: 测的是「这种形状的清单能不能跑通整条链路」,
//   包括两个真实平台带来的差异 —— Figma 走自定义头, Notion 走 Bearer 模板 +
//   必填的常量版本头。官方插件本身对不对, 归插件仓的 build 校验管。
// ============================================================================

const FIXTURES: Record<string, any> = {
  figma: {
    name: 'figma',
    connector: {
      namespace: 'figma',
      displayName: { en: 'Figma', zh: 'Figma' },
      baseUrl: 'https://api.figma.com',
      auth: {
        kind: 'token',
        header: 'X-Figma-Token',
        instructions: { en: 'Figma → Settings → personal access token', zh: '生成 token' },
      },
      permissions: [
        { capability: 'design.read', effect: 'readonly', reason: { en: 'read designs', zh: '读设计稿' } },
        { capability: 'design.export', effect: 'readonly', reason: { en: 'export frames', zh: '导出画板' } },
        { capability: 'message.search', effect: 'readonly', reason: { en: 'read comments', zh: '读评论' } },
        { capability: 'message.create', effect: 'writes', reason: { en: 'reply comments', zh: '回复评论' } },
      ],
      operations: [
        { capability: 'design.read', method: 'GET', path: '/v1/files/{{input.fileKey}}', query: { depth: '{{input.depth}}' }, resultPath: 'document' },
        { capability: 'design.export', method: 'GET', path: '/v1/images/{{input.fileKey}}', query: { ids: '{{input.ids}}' }, resultPath: 'images' },
        { capability: 'message.search', method: 'GET', path: '/v1/files/{{input.fileKey}}/comments', resultPath: 'comments' },
        { capability: 'message.create', method: 'POST', path: '/v1/files/{{input.fileKey}}/comments', body: { message: '{{input.message}}' } },
      ],
      tools: [
        { name: 'get_file', capability: 'design.read', description: { en: 'fetch file tree', zh: '取文件树' }, input: { type: 'object', required: ['fileKey'], properties: { fileKey: { type: 'string' }, depth: { type: 'number' } } } },
        { name: 'export_frame', capability: 'design.export', description: { en: 'render frames', zh: '导出画板' } },
        { name: 'list_comments', capability: 'message.search', description: { en: 'list comments', zh: '列评论' } },
        { name: 'reply_comment', capability: 'message.create', description: { en: 'post a comment', zh: '发评论' } },
      ],
    },
  },
  notion: {
    name: 'notion',
    connector: {
      namespace: 'notion',
      displayName: { en: 'Notion', zh: 'Notion' },
      baseUrl: 'https://api.notion.com',
      /* 漏了这个常量头 Notion 直接 400 —— 它必须活到最终请求上 */
      headers: { 'Notion-Version': '2022-06-28' },
      auth: {
        kind: 'token',
        header: 'Authorization',
        valueTemplate: 'Bearer {{token}}',
        instructions: { en: 'notion.so/my-integrations', zh: '新建 integration' },
      },
      permissions: [
        { capability: 'document.create', effect: 'writes', reason: { en: 'create pages', zh: '建页面' } },
      ],
      operations: [
        {
          capability: 'document.create',
          method: 'POST',
          path: '/v1/pages',
          body: {
            parent: { page_id: '{{input.parentPageId}}' },
            properties: { title: { title: [{ text: { content: '{{input.title}}' } }] } },
            children: '{{input.blocks}}',
          },
        },
      ],
      tools: [
        { name: 'create_page', capability: 'document.create', description: { en: 'create a page', zh: '建页面' }, input: { type: 'object', required: ['parentPageId', 'title'], properties: { parentPageId: { type: 'string' }, title: { type: 'string' }, blocks: { type: 'array', items: { type: 'object' } } } } },
      ],
    },
  },
};

async function loadOfficial(name: string) {
  return JSON.parse(JSON.stringify(FIXTURES[name]));
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  credentials.clear();
  grants.clear();
  remembered.clear();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  connectorRegistry.unregister('figma');
  connectorRegistry.unregister('notion');
  vi.unstubAllGlobals();
});

describe('connector 清单', () => {
  it('两种典型形态 (自定义头 / Bearer 模板 + 常量头) 都合法', async () => {
    for (const name of ['figma', 'notion']) {
      const manifest = await loadOfficial(name);
      const { errors } = validateConnector(manifest.connector);
      expect(errors, `${name}: ${errors.join('; ')}`).toEqual([]);
    }
  });
});

describe('Agent 调用闭环', () => {
  it('注册 → 拿到带命名空间的工具 → 授权后真调得通', async () => {
    const manifest = await loadOfficial('figma');
    const tools = connectorRegistry.register('figma', manifest.connector);

    /* 命名空间前缀是必须的, 且必须符合供应商的工具名规则 */
    expect(tools.map(t => t.name)).toEqual([
      'figma_get_file', 'figma_export_frame', 'figma_list_comments', 'figma_reply_comment',
    ]);
    for (const t of tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);

    /* 副作用摊进描述, 让模型决策时就看得见 */
    const write = tools.find(t => t.name === 'figma_reply_comment')!;
    expect(write.description).toContain('会写入对方平台');
    expect(write.isReadOnly).toBe(false);
    const read = tools.find(t => t.name === 'figma_get_file')!;
    expect(read.isReadOnly).toBe(true);

    // ── 没连账号: 不发请求, 且告诉模型该让用户去哪连 ────────────────────
    const notConnected = await read.function({ fileKey: 'abc' });
    /* 说清在哪填 + 去哪拿 (清单 auth.instructions), 模型才能原样转述给用户 */
    expect(notConnected).toContain('还没配置 API Key');
    expect(notConnected).toContain('左侧「插件」');
    expect(notConnected).toMatch(/获取令牌：.+/);
    expect(fetchSpy).not.toHaveBeenCalled();

    credentials.set('figma', { kind: 'token', token: 'figd_secret' });

    // ── 连了但没授权: 依然不发请求 ──────────────────────────────────────
    const notGranted = await read.function({ fileKey: 'abc' });
    expect(notGranted).toContain('尚未授予');
    expect(fetchSpy).not.toHaveBeenCalled();

    // ── 授权后真调通 ───────────────────────────────────────────────────
    grants.set('figma', new Set(['design.read']));
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ document: { name: 'Home', children: [] } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );

    const out = await read.function({ fileKey: 'abc123', depth: 2 });
    expect(JSON.parse(out as string)).toEqual({ name: 'Home', children: [] });

    const [url, init] = fetchSpy.mock.calls[0] as any;
    expect(url).toBe('https://api.figma.com/v1/files/abc123?depth=2');
    expect(init.headers['X-Figma-Token']).toBe('figd_secret');
    /* 插件本身从头到尾没碰过 token */
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('notion 的 Bearer 模板与常量版本头都落到请求上', async () => {
    const manifest = await loadOfficial('notion');
    const tools = connectorRegistry.register('notion', manifest.connector);
    credentials.set('notion', { kind: 'token', token: 'ntn_secret' });
    grants.set('notion', new Set(['document.create']));

    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ id: 'page-1' }), { status: 200 }));

    const create = tools.find(t => t.name === 'notion_create_page')!;
    await create.function({
      parentPageId: 'parent-1',
      title: '周报',
      blocks: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }],
    });

    const [url, init] = fetchSpy.mock.calls[0] as any;
    expect(url).toBe('https://api.notion.com/v1/pages');
    expect(init.headers.Authorization).toBe('Bearer ntn_secret');
    /* 漏了 Notion-Version 直接 400, 这个头必须来自清单的常量头 */
    expect(init.headers['Notion-Version']).toBe('2022-06-28');

    const body = JSON.parse(init.body);
    expect(body.parent).toEqual({ page_id: 'parent-1' });
    /* blocks 必须还是数组 —— 被拍成字符串就是那种「看着像平台问题」的 400 */
    expect(Array.isArray(body.children)).toBe(true);
  });

  it('两个插件贡献同名工具时撞名被挡住, 而不是后者静默覆盖前者', async () => {
    const manifest = await loadOfficial('notion');
    connectorRegistry.register('notion', manifest.connector);
    expect(() => connectorRegistry.register('notion-fork', manifest.connector))
      .toThrow(/collision/);
    connectorRegistry.unregister('notion-fork');
  });

  it('禁用插件后工具即刻失效 —— 不留下会报错的幽灵工具', async () => {
    const manifest = await loadOfficial('figma');
    const tools = connectorRegistry.register('figma', manifest.connector);
    credentials.set('figma', { kind: 'token', token: 't' });
    grants.set('figma', new Set(['design.read']));

    connectorRegistry.unregister('figma');

    const out = await tools[0].function({ fileKey: 'x' });
    expect(out).toContain('已被卸载或禁用');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
