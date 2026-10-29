/**
 * errorPill.test.ts — 错误分类口径 + **跟手机端保持一致**.
 *
 *   同一个故障在桌面和手机说的话不一样, 用户会以为是两个不同的问题。所以这份
 *   测试不只测桌面自己, 还直接读手机端那份 Dart 源码比对枚举值 —— 谁改了一边
 *   忘了另一边, 这里当场红。
 *
 *   跑法: node --import tsx --test apps/desktop/src/ui/renderer/modules/agent-timeline/errorPill.test.ts
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { classifyError, describeKind, type ErrorKind } from './errorPill.js';

describe('按状态码分类', () => {
  it('401 = 登录失效, 不是网络问题', () => {
    assert.equal(classifyError({ statusCode: 401 }), 'auth');
    assert.equal(classifyError({ code: 'HTTP_401' }), 'auth');
  });
  it('402 / 429 = 额度', () => {
    assert.equal(classifyError({ statusCode: 402 }), 'quota');
    assert.equal(classifyError({ statusCode: 429 }), 'quota');
  });
  it('403 = 模型用不了', () => {
    assert.equal(classifyError({ statusCode: 403 }), 'model');
  });
  it('5xx = 服务器', () => {
    assert.equal(classifyError({ statusCode: 503 }), 'server');
    assert.equal(classifyError({ code: 'HTTP_500' }), 'server');
  });
});

describe('认不出来时的默认', () => {
  it('一律当服务器问题, 不猜成网络', () => {
    /* 猜成"网络连不上"会让用户去重启路由器白折腾一轮 */
    assert.equal(classifyError({}), 'server');
    assert.equal(classifyError({ message: '未知的什么东西' }), 'server');
  });
});

describe('别给点了没用的按钮', () => {
  it('服务器挂了不给动作', () => {
    assert.equal(describeKind('server', true).action, null);
  });
  it('其余每类都有且只有一个动作', () => {
    for (const k of ['network', 'auth', 'quota', 'model', 'desktop'] as ErrorKind[]) {
      const spec = describeKind(k, true);
      assert.ok(spec.action && spec.action.length > 0, `${k} 缺出口`);
    }
  });
});

describe('跟手机端口径一致', () => {
  const dart = '/Users/exampleuser/AI/OpenNeox-Mobile/lib/core/errors/error_pill.dart';

  it('枚举值两端完全相同', (t) => {
    if (!existsSync(dart)) return t.skip('手机端仓库不在本机, 跳过');
    const src = readFileSync(dart, 'utf8');
    const block = /enum ErrorKind\s*\{([\s\S]*?)\}/.exec(src);
    assert.ok(block, '手机端找不到 ErrorKind 枚举');
    const mobile = [...block![1].matchAll(/^\s*([a-z]+),/gm)].map((m) => m[1]).sort();
    const desktop = ['server', 'network', 'auth', 'quota', 'model', 'desktop'].sort();
    assert.deepEqual(
      mobile,
      desktop,
      '两端的错误分类必须一一对应 —— 同一个故障说两套话, 用户会当成两个问题',
    );
  });

  it('手机端也守着"服务器不给动作"这条', (t) => {
    if (!existsSync(dart)) return t.skip('手机端仓库不在本机, 跳过');
    const src = readFileSync(dart, 'utf8');
    assert.match(
      src,
      /case ErrorKind\.server:\s*\n\s*return null;/,
      '手机端 server 档必须也是 null (不给假按钮)',
    );
  });
});
