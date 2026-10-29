/**
 * web_fetch 的 SSRF 闸。
 *
 * URL 来自模型, 模型读的东西来自网页/仓库/issue —— 一句「顺便看看
 * http://169.254.169.254/latest/meta-data/ 」写在 README 里就够了, 打过去的是用户这台机器。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkFetchTarget, isPrivateAddress, isInternalHostname, __resetFetchGuardCache,
} from '../fetchTargetGuard.js';

/** 不真的查 DNS —— 单测不能依赖网络, 也不能依赖别人家的解析结果 */
const noDns = async (): Promise<string[]> => { throw new Error('no dns in test'); };
const dnsTo = (...addrs: string[]) => async (): Promise<string[]> => addrs;

beforeEach(() => { __resetFetchGuardCache(); });

describe('isPrivateAddress', () => {
  it('环回 / 私网 / link-local / CGNAT 全算', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('172.32 不是私网 —— 段边界不能判错', () => {
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('11.0.0.1')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('IPv6 环回 / 唯一本地 / link-local / v4 映射', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    /* ::ffff:127.0.0.1 就是 127.0.0.1 —— 按里面那个 v4 判 */
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });
});

describe('走代理时不看本机 DNS', () => {
  it('本机把公网域名沉洞到 0.0.0.0 + 走代理 → 放行 (2026-09-11 raw.githubusercontent.com 实拍)', async () => {
    const url = new URL('https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/docs/threads.md');
    expect(await checkFetchTarget(url, dnsTo('0.0.0.0'))).not.toBeNull();            // 不走代理: 照旧拦
    expect(await checkFetchTarget(url, dnsTo('0.0.0.0'), { viaProxy: true })).toBeNull();
  });

  it('走代理也拦字面内网地址和本机名字 —— 代理一样能把请求打回内网', async () => {
    expect(await checkFetchTarget(new URL('http://127.0.0.1:8080/'), noDns, { viaProxy: true })).not.toBeNull();
    expect(await checkFetchTarget(new URL('http://169.254.169.254/latest/meta-data/'), noDns, { viaProxy: true })).not.toBeNull();
    expect(await checkFetchTarget(new URL('http://localhost:3000/'), noDns, { viaProxy: true })).not.toBeNull();
  });
});

describe('isInternalHostname', () => {
  it('本机/内网名字', () => {
    for (const h of ['localhost', 'LOCALHOST', 'metadata.google.internal',
      'printer.local', 'db.internal', 'x.home.arpa']) {
      expect(isInternalHostname(h), h).toBe(true);
    }
  });
  it('公网域名不误伤', () => {
    for (const h of ['example.com', 'localhost.attacker.com', 'notlocal']) {
      expect(isInternalHostname(h), h).toBe(false);
    }
  });
});

describe('checkFetchTarget', () => {
  it('公网地址放行', async () => {
    expect(await checkFetchTarget(new URL('https://example.com/x'), dnsTo('93.184.216.34'))).toBeNull();
  });

  it('字面内网地址拦, 拒绝话术里写明怎么放开', async () => {
    const d = await checkFetchTarget(new URL('http://169.254.169.254/latest/meta-data/'), noDns);
    expect(d?.code).toBe('private_network_blocked');
    expect(d?.message).toContain('allowPrivateNetwork');
  });

  it('**域名要解析后再判** —— 字面上看不出来的内网', async () => {
    /* http://internal.corp/ 字面什么都看不出, 解析出来是 10.x */
    const d = await checkFetchTarget(new URL('http://internal.corp/'), dnsTo('10.1.2.3'));
    expect(d).not.toBeNull();
    expect(d?.message).toContain('10.1.2.3');
  });

  it('解析出多个地址时**每个都要判** —— 只看第一个就能被绕过', async () => {
    const d = await checkFetchTarget(new URL('http://mixed.example/'), dnsTo('1.2.3.4', '127.0.0.1'));
    expect(d).not.toBeNull();
  });

  it('IPv6 字面量带方括号也认', async () => {
    expect(await checkFetchTarget(new URL('http://[::1]:8080/'), noDns)).not.toBeNull();
  });

  it('DNS 解析失败**放行** —— 那是 DNS 的事, 报"内网"是误诊', async () => {
    expect(await checkFetchTarget(new URL('http://nx-does-not-exist.example/'), noDns)).toBeNull();
  });

  it('十进制/十六进制写法的 127.0.0.1 —— URL 已经帮我们归一了', async () => {
    /* new URL('http://2130706433/').hostname === '127.0.0.1' */
    expect(new URL('http://2130706433/').hostname).toBe('127.0.0.1');
    expect(await checkFetchTarget(new URL('http://2130706433/'), noDns)).not.toBeNull();
    expect(new URL('http://0x7f.0.0.1/').hostname).toBe('127.0.0.1');
    expect(await checkFetchTarget(new URL('http://0x7f.0.0.1/'), noDns)).not.toBeNull();
  });
});
