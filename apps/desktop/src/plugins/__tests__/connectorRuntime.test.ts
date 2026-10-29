/**
 * Connector 运行时 —— 模板 / 闸门 / 执行器 / 校验
 *
 *   这一层的每条断言都对应一个具体的失败模式, 不是为了覆盖率:
 *   插值拍扁类型、缺参发成 undefined、路径穿越、凭据打给别的主机、
 *   低报副作用、越权贡献。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  interpolateString,
  interpolateValue,
  interpolatePath,
  interpolateQuery,
  MISSING,
} from '../connector/template.js';
import { evaluateGate } from '../connector/gate.js';
import { executeCapability } from '../connector/executor.js';
import { validateConnector } from '../connector/validate.js';
import type { GrantStore, BudgetStore } from '../connector/grantStore.js';
import type { PluginConnectorDefinition } from '@neoxlabs/platform/shared/plugin-connector.js';

// ============================================================================
// Fixtures
// ============================================================================

function memoryGrants(granted: string[] = [], remembered: string[] = []): GrantStore {
  const g = new Set(granted);
  const r = new Set(remembered);
  return {
    isGranted: (_id, cap) => g.has(cap),
    isRemembered: (_id, cap) => r.has(cap),
    remember: (_id, cap) => { r.add(cap); },
  };
}

function memoryBudget(limit: number): BudgetStore {
  let spent = 0;
  return {
    remainingUsd: () => limit - spent,
    charge: (_id, usd) => { spent += usd; },
  };
}

const CONNECTOR: PluginConnectorDefinition = {
  namespace: 'demo',
  displayName: { en: 'Demo', zh: '演示' },
  baseUrl: 'https://api.example.com',
  headers: { 'X-Api-Version': '2026-01-01' },
  auth: { kind: 'token', header: 'X-Demo-Token', instructions: { en: 'get a token' } },
  permissions: [
    { capability: 'document.read', effect: 'readonly', reason: { en: 'read docs', zh: '读文档' } },
    { capability: 'document.create', effect: 'writes', reason: { en: 'create docs', zh: '建文档' } },
    { capability: 'document.delete', effect: 'destructive', reason: { en: 'delete docs', zh: '删文档' } },
    {
      capability: 'design.render',
      effect: 'costly',
      reason: { en: 'render', zh: '渲染' },
      cost: { unit: 'call', approxUsd: 0.5 },
    },
  ],
  operations: [
    { capability: 'document.read', method: 'GET', path: '/v1/docs/{{input.docId}}', query: { depth: '{{input.depth}}' }, resultPath: 'data' },
    { capability: 'document.create', method: 'POST', path: '/v1/docs', body: { title: '{{input.title}}', blocks: '{{input.blocks}}' } },
    { capability: 'document.delete', method: 'DELETE', path: '/v1/docs/{{input.docId}}' },
    { capability: 'design.render', method: 'POST', path: '/v1/render' },
  ],
  tools: [
    { name: 'read_doc', capability: 'document.read', description: { en: 'read' } },
    { name: 'create_doc', capability: 'document.create', description: { en: 'create' } },
  ],
};

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================================
// 模板
// ============================================================================

describe('template interpolation', () => {
  it('整串占位符保留原始类型 — 数组不能被拍成字符串', () => {
    const blocks = [{ type: 'paragraph' }, { type: 'heading' }];
    expect(interpolateString('{{input.blocks}}', { input: { blocks } })).toEqual(blocks);
    /* 拍扁会得到 "[object Object],[object Object]" 然后上游 400 */
    expect(typeof interpolateString('{{input.blocks}}', { input: { blocks } })).toBe('object');
  });

  it('取不到值返回 MISSING 而不是空串', () => {
    expect(interpolateString('{{input.depth}}', { input: {} })).toBe(MISSING);
  });

  it('body 里 MISSING 的键被删掉而不是置 null', () => {
    const out = interpolateValue(
      { title: '{{input.title}}', blocks: '{{input.blocks}}' },
      { input: { title: 'hi' } },
    ) as Record<string, unknown>;
    expect(out).toEqual({ title: 'hi' });
    expect('blocks' in out).toBe(false);
  });

  it('query 丢掉取不到的参数', () => {
    expect(interpolateQuery({ depth: '{{input.depth}}', id: '{{input.id}}' }, { input: { id: 7 } }))
      .toEqual({ id: '7' });
  });

  it('路径片段 URL 编码 — 挡住路径穿越', () => {
    const out = interpolatePath('/v1/docs/{{input.docId}}', { input: { docId: '../../admin' } });
    expect(out).toBe('/v1/docs/..%2F..%2Fadmin');
    expect(out).not.toContain('/../');
  });

  it('路径参数缺失直接抛 — 不能发一个残缺 URL 出去', () => {
    expect(() => interpolatePath('/v1/docs/{{input.docId}}', { input: {} })).toThrow(/missing required path/);
  });

  it('只认 input / connection 两个作用域', () => {
    expect(interpolateString('{{process.env.HOME}}', {})).toBe(MISSING);
    expect(interpolateString('{{input.__proto__}}', { input: {} })).toBe(MISSING);
  });
});

// ============================================================================
// 闸门
// ============================================================================

describe('capability gate', () => {
  const ctxBase = { installationId: 'demo' };

  it('未声明的能力被拒 (纵深防御)', () => {
    const d = evaluateGate(CONNECTOR, 'demo', 'task.create' as any, {
      ...ctxBase, grants: memoryGrants(['task.create']),
    });
    expect(d.allow).toBe(false);
    expect((d as any).code).toBe('capability_not_declared');
  });

  it('声明了但用户没授予 → 拒', () => {
    const d = evaluateGate(CONNECTOR, 'demo', 'document.read', { ...ctxBase, grants: memoryGrants([]) });
    expect((d as any).code).toBe('capability_not_granted');
  });

  it('readonly 放行, 不需要确认', () => {
    const d = evaluateGate(CONNECTOR, 'demo', 'document.read', {
      ...ctxBase, grants: memoryGrants(['document.read']),
    });
    expect(d.allow).toBe(true);
  });

  it('writes 首次要确认, 记住之后放行', () => {
    const grants = memoryGrants(['document.create']);
    const first = evaluateGate(CONNECTOR, 'demo', 'document.create', { ...ctxBase, grants });
    expect((first as any).code).toBe('confirmation_required');
    expect((first as any).rememberable).toBe(true);

    evaluateGate(CONNECTOR, 'demo', 'document.create', {
      ...ctxBase, grants, confirmed: true, rememberChoice: true,
    });
    const third = evaluateGate(CONNECTOR, 'demo', 'document.create', { ...ctxBase, grants });
    expect(third.allow).toBe(true);
  });

  it('destructive 永远每次问, 且不可记住', () => {
    const grants = memoryGrants(['document.delete']);
    evaluateGate(CONNECTOR, 'demo', 'document.delete', {
      ...ctxBase, grants, confirmed: true, rememberChoice: true,
    });
    const next = evaluateGate(CONNECTOR, 'demo', 'document.delete', { ...ctxBase, grants });
    expect((next as any).code).toBe('confirmation_required');
    expect((next as any).rememberable).toBe(false);
  });

  it('costly 超预算被拦, 够用则扣账', () => {
    const grants = memoryGrants(['design.render']);
    const poor = evaluateGate(CONNECTOR, 'demo', 'design.render', {
      ...ctxBase, grants, budgets: memoryBudget(0.1), confirmed: true,
    });
    expect((poor as any).code).toBe('budget_exceeded');

    const budgets = memoryBudget(1.0);
    const rich = evaluateGate(CONNECTOR, 'demo', 'design.render', {
      ...ctxBase, grants, budgets, confirmed: true,
    });
    expect(rich.allow).toBe(true);
    expect(budgets.remainingUsd('demo')).toBeCloseTo(0.5);
  });

  it('确认框展示的是人话理由, 不是 capability 字符串', () => {
    const d = evaluateGate(CONNECTOR, 'demo', 'document.create', {
      ...ctxBase, grants: memoryGrants(['document.create']),
    });
    expect((d as any).message.zh).toBe('建文档');
  });
});

// ============================================================================
// 执行器
// ============================================================================

describe('declarative executor', () => {
  const gate = () => ({ installationId: 'demo', grants: memoryGrants(['document.read', 'document.create']), confirmed: true });

  it('凭据只在闸门放行后注入, 且走 auth 声明的头', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ data: { ok: 1 } }));
    const res = await executeCapability({
      connector: CONNECTOR,
      pluginName: 'demo',
      capability: 'document.read',
      input: { docId: 'abc', depth: 2 },
      credential: { kind: 'token', token: 'secret-token' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });

    expect(res.ok).toBe(true);
    expect((res as any).data).toEqual({ ok: 1 });

    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://api.example.com/v1/docs/abc?depth=2');
    expect(init.headers['X-Demo-Token']).toBe('secret-token');
    expect(init.headers['X-Api-Version']).toBe('2026-01-01');
    /* 跟随跳转会把凭据带去别的主机 */
    expect(init.redirect).toBe('error');
  });

  it('闸门不放行时一个请求都不发', async () => {
    const fetchImpl = vi.fn();
    const res = await executeCapability({
      connector: CONNECTOR,
      pluginName: 'demo',
      capability: 'document.read',
      input: { docId: 'abc' },
      credential: { kind: 'token', token: 't' },
      gate: { installationId: 'demo', grants: memoryGrants([]) },
      fetchImpl: fetchImpl as any,
    });
    expect(res.ok).toBe(false);
    expect((res as any).code).toBe('capability_not_granted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /* 路径插值已经 URL 编码, 所以 connection 实际上拐不走 origin —— origin 比对是
   * 兜底那一层。这条断言守的是「凭据无论如何不会打到别的主机」这个结果。 */
  it('connection 被写脏也不会把凭据送去别的主机', async () => {
    const evil: PluginConnectorDefinition = {
      ...CONNECTOR,
      baseUrl: 'https://api.example.com/{{connection.tenant}}',
    };
    const fetchImpl = vi.fn();
    const res = await executeCapability({
      connector: evil,
      pluginName: 'demo',
      capability: 'document.read',
      input: { docId: 'x' },
      /* URL 编码之后穿不出 origin, 但真要穿出去就必须被 origin 比对挡住 */
      connection: { tenant: 'https://evil.test/' },
      credential: { kind: 'token', token: 'secret' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });
    if (res.ok) throw new Error('should not have succeeded');
    /* 要么 origin 不符被拒, 要么被编码后仍打在自家 origin —— 两种都不能把 token 送出去 */
    const [url] = (fetchImpl.mock.calls[0] ?? ['']) as any;
    if (fetchImpl.mock.calls.length > 0) {
      expect(String(url).startsWith('https://api.example.com/')).toBe(true);
    }
  });

  it('凭据类型与声明不符时拒发', async () => {
    const fetchImpl = vi.fn();
    const res = await executeCapability({
      connector: CONNECTOR,
      pluginName: 'demo',
      capability: 'document.read',
      input: { docId: 'x' },
      credential: { kind: 'oauth2', accessToken: 'a' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });
    expect((res as any).code).toBe('credential_mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('上游报错原文被截断, 且不回显请求头', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(2000), { status: 403 }));
    const res = await executeCapability({
      connector: CONNECTOR,
      pluginName: 'demo',
      capability: 'document.read',
      input: { docId: 'x' },
      credential: { kind: 'token', token: 'secret-token' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });
    expect(res.ok).toBe(false);
    expect((res as any).status).toBe(403);
    expect((res as any).message.length).toBeLessThanOrEqual(500);
    expect((res as any).message).not.toContain('secret-token');
  });

  it('pathInject 在 origin 校验之后才把 token 写进路径, 且不带头', async () => {
    const telegram: PluginConnectorDefinition = {
      ...CONNECTOR,
      baseUrl: 'https://api.telegram.org',
      headers: {},
      auth: { kind: 'token', pathInject: true, instructions: { en: 'bot token' } },
      operations: [
        { capability: 'document.read', method: 'GET', path: '/bot{{token}}/getUpdates' },
        ...CONNECTOR.operations.slice(1),
      ],
    };
    const fetchImpl = vi.fn(async () => okResponse({ ok: true }));
    const res = await executeCapability({
      connector: telegram,
      pluginName: 'telegram',
      capability: 'document.read',
      credential: { kind: 'token', token: '123:ABC' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe(`https://api.telegram.org/bot${encodeURIComponent('123:ABC')}/getUpdates`);
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers['X-Demo-Token']).toBeUndefined();
  });

  it('queryParam 在 origin 校验之后才把 token 写进 query, 且不带头', async () => {
    const trello: PluginConnectorDefinition = {
      ...CONNECTOR,
      baseUrl: 'https://api.trello.com',
      headers: {},
      auth: { kind: 'token', queryParam: 'token', instructions: { en: 'trello token' } },
      operations: [
        { capability: 'document.read', method: 'GET', path: '/1/cards/{{input.docId}}', query: { key: '{{connection.apiKey}}' } },
        ...CONNECTOR.operations.slice(1),
      ],
    };
    const fetchImpl = vi.fn(async () => okResponse({ id: 'c1' }));
    const res = await executeCapability({
      connector: trello,
      pluginName: 'trello',
      capability: 'document.read',
      input: { docId: 'abc' },
      connection: { apiKey: 'key123' },
      credential: { kind: 'token', token: 'tok-secret' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://api.trello.com');
    expect(parsed.pathname).toBe('/1/cards/abc');
    expect(parsed.searchParams.get('key')).toBe('key123');
    expect(parsed.searchParams.get('token')).toBe('tok-secret');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('tokenEncoding=base64 按 email:api_token 做成 Basic 头', async () => {
    const atlassian: PluginConnectorDefinition = {
      ...CONNECTOR,
      auth: {
        kind: 'token',
        header: 'Authorization',
        valueTemplate: 'Basic {{token}}',
        tokenEncoding: 'base64',
        instructions: { en: 'email:api_token' },
      },
    };
    const fetchImpl = vi.fn(async () => okResponse({ data: { ok: 1 } }));
    await executeCapability({
      connector: atlassian,
      pluginName: 'atlassian',
      capability: 'document.read',
      input: { docId: 'x' },
      credential: { kind: 'token', token: 'ada@ex.com:secret' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });
    const [, init] = fetchImpl.mock.calls[0] as any;
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('ada@ex.com:secret', 'utf8').toString('base64')}`);
  });

  it('allowedHostSuffix 只允许单个标签的子域, 脏值拒发', async () => {
    const zendesk: PluginConnectorDefinition = {
      ...CONNECTOR,
      baseUrl: 'https://{{connection.subdomain}}.zendesk.com',
      allowedHostSuffix: 'zendesk.com',
    };
    const fetchImpl = vi.fn(async () => okResponse({ data: { ok: 1 } }));
    const ok = await executeCapability({
      connector: zendesk,
      pluginName: 'zendesk',
      capability: 'document.read',
      input: { docId: '1' },
      connection: { subdomain: 'acme' },
      credential: { kind: 'token', token: 't' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });
    expect(ok.ok).toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://acme.zendesk.com/v1/docs/1');

    const evil = await executeCapability({
      connector: zendesk,
      pluginName: 'zendesk',
      capability: 'document.read',
      input: { docId: '1' },
      connection: { subdomain: 'not-zendesk.com' },
      credential: { kind: 'token', token: 'secret' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });
    expect(evil.ok).toBe(false);
    expect((evil as any).code).toBe('origin_mismatch');
  });

  it('固定头可以插 connection, 缺值则拒发且不带 token', async () => {
    const harvest: PluginConnectorDefinition = {
      ...CONNECTOR,
      headers: { 'Harvest-Account-Id': '{{connection.accountId}}', 'X-Api-Version': '2026-01-01' },
    };
    const fetchImpl = vi.fn(async () => okResponse({ data: { ok: 1 } }));
    const ok = await executeCapability({
      connector: harvest,
      pluginName: 'harvest',
      capability: 'document.read',
      input: { docId: '1' },
      connection: { accountId: '123' },
      credential: { kind: 'token', token: 't' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });
    expect(ok.ok).toBe(true);
    expect((fetchImpl.mock.calls[0] as any)[1].headers['Harvest-Account-Id']).toBe('123');

    const missingFetch = vi.fn();
    const missing = await executeCapability({
      connector: harvest,
      pluginName: 'harvest',
      capability: 'document.read',
      input: { docId: '1' },
      credential: { kind: 'token', token: 'secret' },
      gate: gate(),
      fetchImpl: missingFetch as any,
    });
    expect(missing.ok).toBe(false);
    expect((missing as any).code).toBe('bad_input');
    expect(missingFetch).not.toHaveBeenCalled();
  });

  it('body 里的数组保持数组形态发出去', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ id: 'p1' }));
    await executeCapability({
      connector: CONNECTOR,
      pluginName: 'demo',
      capability: 'document.create',
      input: { title: 'T', blocks: [{ type: 'paragraph' }] },
      credential: { kind: 'token', token: 't' },
      gate: gate(),
      fetchImpl: fetchImpl as any,
    });
    const [, init] = fetchImpl.mock.calls[0] as any;
    expect(JSON.parse(init.body)).toEqual({ title: 'T', blocks: [{ type: 'paragraph' }] });
  });
});

// ============================================================================
// 校验
// ============================================================================

describe('connector validation', () => {
  const base = () => JSON.parse(JSON.stringify(CONNECTOR));

  it('合法清单通过', () => {
    expect(validateConnector(CONNECTOR).errors).toEqual([]);
  });

  it('低报副作用被拒', () => {
    const c = base();
    c.permissions[2].effect = 'readonly'; // document.delete
    const { errors } = validateConnector(c);
    expect(errors.some(e => e.includes('understates its side effect'))).toBe(true);
  });

  it('工具用了未声明的能力被拒', () => {
    const c = base();
    c.tools.push({ name: 'sneaky', capability: 'task.delete', description: { en: 'x' } });
    const { errors } = validateConnector(c);
    expect(errors.some(e => e.includes('not declared in connector.permissions'))).toBe(true);
  });

  it('清单里写死鉴权头被拒 —— 那会绕过整个闸门', () => {
    const c = base();
    c.headers.Authorization = 'Bearer hardcoded';
    const { errors } = validateConnector(c);
    expect(errors.some(e => e.includes('credentials are injected by the host'))).toBe(true);
  });

  it('baseUrl 主机段带占位符但没有后缀被拒', () => {
    const c = base();
    c.baseUrl = 'https://{{connection.tenant}}.example.com';
    const { errors } = validateConnector(c);
    expect(errors.some(e => e.includes('allowedHostSuffix'))).toBe(true);
  });

  it('allowedHostSuffix 钉死后, 子域占位符可以通过校验', () => {
    const c = base();
    c.baseUrl = 'https://{{connection.subdomain}}.zendesk.com';
    c.allowedHostSuffix = 'zendesk.com';
    expect(validateConnector(c).errors).toEqual([]);
  });

  it('allowedHostSuffix 与 host 对不上被拒', () => {
    const c = base();
    c.baseUrl = 'https://{{connection.subdomain}}.zendesk.com';
    c.allowedHostSuffix = 'evil.com';
    expect(validateConnector(c).errors.some(e => e.includes('baseUrl'))).toBe(true);
  });

  it('固定头里写 {{token}} 被拒', () => {
    const c = base();
    c.headers['X-Extra'] = 'Bearer {{token}}';
    expect(validateConnector(c).errors.some(e => e.includes('{{token}}'))).toBe(true);
  });

  it('http 明文被拒', () => {
    const c = base();
    c.baseUrl = 'http://api.example.com';
    expect(validateConnector(c).errors.some(e => e.includes('https'))).toBe(true);
  });

  it('costly 不带成本口径被拒 — 预算闸门无从判断', () => {
    const c = base();
    delete c.permissions[3].cost;
    expect(validateConnector(c).errors.some(e => e.includes('cost.approxUsd'))).toBe(true);
  });

  it('queryParam 可以省略 header', () => {
    const ok = base();
    ok.auth = { kind: 'token', queryParam: 'token', instructions: { en: 'trello token' } };
    expect(validateConnector(ok).errors).toEqual([]);
  });

  it('pathInject 可以省略 header; 路径里写 {{token}} 却没开 pathInject 被拒', () => {
    const ok = base();
    ok.auth = { kind: 'token', pathInject: true, instructions: { en: 'bot token' } };
    ok.operations[0].path = '/bot{{token}}/getUpdates';
    expect(validateConnector(ok).errors).toEqual([]);

    const bad = base();
    bad.operations[0].path = '/bot{{token}}/getUpdates';
    expect(validateConnector(bad).errors.some(e => e.includes('pathInject'))).toBe(true);
  });

  it('没有 operation 实现的工具被拒', () => {
    const c = base();
    c.permissions.push({ capability: 'task.read', effect: 'readonly', reason: { en: 'r' } });
    c.tools.push({ name: 'orphan', capability: 'task.read', description: { en: 'x' } });
    expect(validateConnector(c).errors.some(e => e.includes('no operation implementing'))).toBe(true);
  });
});
