/**
 * 上游返回的 HTML 错误页必须先清洗，不能原样进入 UI。
 *
 *   HTML 错误页可能包含完整的文档、脚本和内联资源，错误卡片只应显示可读摘要。
 *   entry-client-*.js 的 modulepreload、内联 SVG logo 的 data URI、"404 - Page Not Found"
 *   …占了大半屏。真因是 classifyError 里的 HTML 清洗**只写在 502/503/504 和 5xx
 *   两个分支**, 404 / 401 / 403 / 402 / 400 全都直接用原始 response body。
 *
 *   触发条件一点都不刁钻: Base URL 少写一段路径 → 打到人家官网 → 拿回一整页 404 HTML。
 *   中转站挂掉返 Cloudflare 拦截页、代理返登录页, 全是同一类。
 *
 *   这个测试固定清洗位于统一错误入口，而不是只覆盖某一个状态码；下面按状态码逐个检查，
 *   将来谁新加一个分支忘了清洗, 这里就会红。
 */
import { describe, expect, it } from 'vitest';
import { classifyError } from '../errors.js';

/** 代表性的 HTML 错误页特征（截断到关键内容）。 */
const HTML_404_PAGE = `<!DOCTYPE html><html lang="en" dir="ltr" data-locale="en"><head><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width, initial-scale=1">`
  + `<link href="/_build/assets/entry-client-VF7ouASi.css" rel="stylesheet" />`
  + `<meta name="description" content="OpenCode - The open source coding agent."/>`
  + `<title>Not Found | opencode</title></head><body><div id="app">`
  + `<img src="data:image/svg+xml,%3csvg%20width='234'%20height='42'%20viewBox='0%200%20234%2042'`
  + `%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M18%2030H6V18H18V30Z'%3e%3c/svg%3e" alt="logo">`
  + `<h1 data-slot="title">404 - Page Not Found</h1>`
  + `<a href="/docs">Docs</a></div></body></html>`;

function httpError(status: number, body: unknown) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status, data: body, headers: {} },
  };
}

/* 一条能进 UI 的文案长什么样: 不含标签、不含 data URI、不是一整页 */
function assertPresentable(message: string): void {
  expect(message).not.toContain('<!DOCTYPE');
  expect(message).not.toContain('<html');
  expect(message).not.toContain('modulepreload');
  expect(message).not.toContain('data:image/svg+xml');
  expect(message.length).toBeLessThanOrEqual(400);
}

describe('HTML 错误页不进 UI', () => {
  /* 逐个覆盖状态码，确保所有 HTTP 错误分支都执行清洗。 */
  for (const status of [400, 401, 402, 403, 404, 429, 500, 502, 503]) {
    it(`HTTP ${status} 返回 HTML 页时, message 是一句人话而不是整页 HTML`, () => {
      const err = classifyError(httpError(status, HTML_404_PAGE));
      assertPresentable(err.message);
    /* 原始 body 保存在 context 中供排障使用，但不进入 UI 文案。 */
      expect(err.context?.rawMessage ?? '').toContain('<!DOCTYPE');
    });
  }

  it('正常的 JSON 错误照原样透出, 不被这层清洗改写', () => {
    const err = classifyError(httpError(400, { error: { message: 'model not found: foo-1' } }));
    expect(err.message).toContain('model not found: foo-1');
  });

  it('超长的非 HTML body 也要截断 —— 一屏日志转储同样不是错误提示', () => {
    const huge = `upstream said: ${'x'.repeat(5000)}`;
    const err = classifyError(httpError(400, { error: { message: huge } }));
    expect(err.message.length).toBeLessThanOrEqual(401);
    expect(err.message.startsWith('upstream said: ')).toBe(true);
  });
});

/**
 * 401 里上游明确表示模型不支持时，不能误报为 key 有问题。
 *
 *   代理对不支持的组合可能返回 HTTP 401 + ModelError；仅按状态码判断会打出
 *   「API key 无效或已过期, 去设置里检查这个供应商的 key」—— 而 key 是好的,
 *   同一个 key 换 deepseek 立刻能用。用户照提示换 key 换多少次都一样。
 */
describe('401 的模型错误不能报成认证错误', () => {
  it('上游说 not supported for format → MODEL_NOT_SUPPORTED, 不是 UNAUTHORIZED', () => {
    const err = classifyError(httpError(401, {
      error: { type: 'ModelError', message: 'Model grok-4.5 is not supported for format anthropic' },
    }));
    expect(err.code).toBe('MODEL_NOT_SUPPORTED');
    expect(err.retryable).toBe(false);
    /* 保留上游错误摘要，因为它比通用文案更准确。 */
    expect(err.message).toContain('not supported for format anthropic');
  });

  it('真正的认证失败仍然是 UNAUTHORIZED —— 别把这条判歪了', () => {
    for (const msg of ['Missing API key.', 'invalid api key', 'authentication failed']) {
      expect(classifyError(httpError(401, { error: { message: msg } })).code).toBe('UNAUTHORIZED');
    }
  });

  it('只提 model 但没说不支持的, 不改判 (宁可少认, 不能猜)', () => {
    expect(classifyError(httpError(401, { error: { message: 'model quota exceeded for this key' } })).code)
      .toBe('UNAUTHORIZED');
  });
});
