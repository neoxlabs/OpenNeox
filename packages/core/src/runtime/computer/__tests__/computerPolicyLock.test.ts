/**
 * 每 App 授权策略 + 同 App 并行锁。
 *
 * 两件事都不是洁癖:
 *   · 策略 —— 用户/企业要能钉死"只准动这几个 App";
 *   · 锁   —— 桥里的元素表是全局一张, 两路并发会互相把编号作废, 最坏的情况是
 *             在**另一个 App** 上点了一个从没见过的按钮, 而且报成功。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { parseComputerUsePolicy, checkComputerUsePolicy, __resetComputerPolicyCache } from '../computerPolicy.js';
import { withAppLock, __resetComputerLocks } from '../computerLock.js';

beforeEach(() => { __resetComputerPolicyCache(); __resetComputerLocks(); });

describe('每 App 授权策略', () => {
  it('默认 open —— 不写配置就是原来的行为, 不该把功能关掉', () => {
    const p = parseComputerUsePolicy({});
    expect(p).toEqual({ policy: 'open', allow: [], deny: [] });
    expect(checkComputerUsePolicy('Calculator', p)).toBeNull();
  });

  it('deny 名单挡住指定 App, 别的照常', () => {
    const p = parseComputerUsePolicy({ computerUse: { deny: ['Mail', 'com.apple.Safari'] } });
    expect(checkComputerUsePolicy('Mail', p)?.code).toBe('app_denied_by_policy');
    expect(checkComputerUsePolicy('mail', p)?.code).toBe('app_denied_by_policy');   // 大小写不敏感
    expect(checkComputerUsePolicy('com.apple.Safari', p)?.code).toBe('app_denied_by_policy');
    expect(checkComputerUsePolicy('Calculator', p)).toBeNull();
  });

  it('名字按整体相等比, 不做包含 —— "Mail" 不该把 "Mailspring" 一起拦了', () => {
    const p = parseComputerUsePolicy({ computerUse: { deny: ['Mail'] } });
    expect(checkComputerUsePolicy('Mailspring', p)).toBeNull();
  });

  it('bundleId 允许前缀匹配 —— com.mk.neox 覆盖 com.mk.neox.dev', () => {
    const p = parseComputerUsePolicy({ computerUse: { deny: ['com.mk.neox'] } });
    expect(checkComputerUsePolicy('com.mk.neox.dev', p)?.code).toBe('app_denied_by_policy');
  });

  it('allowlist 模式: 名单外一律拒, 且告诉模型现在允许哪些', () => {
    const p = parseComputerUsePolicy({ computerUse: { policy: 'allowlist', allow: ['Calculator'] } });
    expect(checkComputerUsePolicy('Calculator', p)).toBeNull();
    const d = checkComputerUsePolicy('QQ', p);
    expect(d?.code).toBe('app_not_in_allowlist');
    expect(d?.message).toContain('Calculator');   /* 拒绝要说清现状, 否则模型只能瞎猜 */
  });

  it('deny 优先于 allow —— 两个名单都写了按拒算, 不按写的顺序', () => {
    const p = parseComputerUsePolicy({ computerUse: { policy: 'allowlist', allow: ['QQ'], deny: ['QQ'] } });
    expect(checkComputerUsePolicy('QQ', p)?.code).toBe('app_denied_by_policy');
  });

  it('不指定 app (= 前台) 这一层不判 —— 交给桥按真实前台判硬线', () => {
    const p = parseComputerUsePolicy({ computerUse: { policy: 'allowlist', allow: [] } });
    expect(checkComputerUsePolicy(undefined, p)).toBeNull();
    expect(checkComputerUsePolicy('', p)).toBeNull();
  });

  it('配置写坏了不当安全边界用 —— 回落 open 而不是全拦', () => {
    expect(parseComputerUsePolicy({ computerUse: { policy: 'nonsense', allow: 'not-an-array' } }))
      .toEqual({ policy: 'open', allow: [], deny: [] });
  });
});

describe('同 App 并行锁', () => {
  it('同一个 App 上串行 —— 后来的必须等前一个跑完', async () => {
    const order: string[] = [];
    const slow = withAppLock('QQ', 'a', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 60));
      order.push('a-end');
    });
    const fast = withAppLock('QQ', 'b', async () => { order.push('b-start'); order.push('b-end'); });
    await Promise.all([slow, fast]);
    /* 交错就是坏的: a-start, b-start, … 说明两路同时在动同一个 App */
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('不同 App 之间照样并行 —— 别为了安全把能力白扔了', async () => {
    const order: string[] = [];
    const a = withAppLock('QQ', 'a', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 60));
      order.push('a-end');
    });
    const b = withAppLock('微信', 'b', async () => { order.push('b-start'); order.push('b-end'); });
    await Promise.all([a, b]);
    expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
  });

  it('前一路抛异常不该把队伍卡死', async () => {
    await expect(withAppLock('QQ', 'boom', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(withAppLock('QQ', 'after', async () => 'ok')).resolves.toBe('ok');
  });

  it('不指定 app 的调用彼此也要串行 —— 前台只有一个', async () => {
    const order: string[] = [];
    const a = withAppLock(undefined, 'a', async () => {
      order.push('a-start'); await new Promise((r) => setTimeout(r, 40)); order.push('a-end');
    });
    const b = withAppLock(undefined, 'b', async () => { order.push('b'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });
});
