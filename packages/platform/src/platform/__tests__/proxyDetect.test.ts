/**
 * 系统代理探测 —— 各平台字段解析
 * ═══════════════════════════════════════════════════════════════════════════
 * 旧实现只读 macOS 的 HTTP/HTTPS 两个字段: SOCKS、PAC、Windows 系统设置、GNOME 全漏,
 * 于是"用户明明开了代理"却被判成无代理直连。这些用例钉住每一类都真的被读进来。
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../proxy/detect.js';
import { parseProxyUrl, emptyProxyConfig, endpointToUrl } from '../proxy/types.js';
import { compilePac } from '../proxy/pac.js';

describe('parseProxyUrl', () => {
  it('认 socks5 / socks4 / http / https', () => {
    expect(parseProxyUrl('socks5://127.0.0.1:7890')).toMatchObject({ kind: 'socks5', port: 7890 });
    expect(parseProxyUrl('socks5h://127.0.0.1:1080')).toMatchObject({ kind: 'socks5' });
    expect(parseProxyUrl('socks4a://10.0.0.1:1080')).toMatchObject({ kind: 'socks4' });
    expect(parseProxyUrl('http://127.0.0.1:7890')).toMatchObject({ kind: 'http', port: 7890 });
    expect(parseProxyUrl('https://proxy.corp:8443')).toMatchObject({ kind: 'https', port: 8443 });
  });
  it('裸 host:port 按 http 处理 (Windows 注册表 / 老 .zshrc 的写法)', () => {
    expect(parseProxyUrl('127.0.0.1:7890')).toMatchObject({ kind: 'http', host: '127.0.0.1', port: 7890 });
  });
  it('带认证', () => {
    const ep = parseProxyUrl('http://u%40x:p%3Aw@1.2.3.4:8080');
    expect(ep).toMatchObject({ username: 'u@x', password: 'p:w' });
    expect(endpointToUrl(ep!)).toContain('@1.2.3.4:8080');
  });
  it('认不出来就返回 null —— 绝不猜', () => {
    expect(parseProxyUrl('')).toBeNull();
    expect(parseProxyUrl('   ')).toBeNull();
    expect(parseProxyUrl('ftp://1.2.3.4:21')).toBeNull();
    expect(parseProxyUrl('http://1.2.3.4:99999')).toBeNull();
  });
});

describe('macOS scutil 解析', () => {
  /* 代表 macOS `scutil --proxy` 的完整字典输出。 */
  const REAL = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1/8
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : localhost
    5 : *.local
    6 : *.crashlytics.com
    7 : <local>
    8 : http://holymastercard.com
    9 : https://www.betternanobanana.com
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}`;

  it('三条通道全读到 —— 旧实现漏掉的 SOCKS 在这里', () => {
    const cfg = __internal.parseMacOSProxyDump(REAL)!;
    expect(cfg.http).toMatchObject({ kind: 'http', host: '127.0.0.1', port: 7890 });
    expect(cfg.https).toMatchObject({ kind: 'http', port: 7890 });
    expect(cfg.socks).toMatchObject({ kind: 'socks5', port: 7890 });
    expect(cfg.exceptions).toHaveLength(10);
    expect(cfg.exceptions).toContain('<local>');
    expect(cfg.pacUrl).toBeNull();
  });

  it('单独关掉 HTTPS → https 槽为空 (不替用户合成)', () => {
    const cfg = __internal.parseMacOSProxyDump(REAL.replace('HTTPSEnable : 1', 'HTTPSEnable : 0'))!;
    expect(cfg.http).not.toBeNull();
    expect(cfg.https).toBeNull();
  });

  it('只开 SOCKS —— 旧实现在这种配置下判"无代理"直连', () => {
    const onlySocks = REAL.replace('HTTPEnable : 1', 'HTTPEnable : 0').replace('HTTPSEnable : 1', 'HTTPSEnable : 0');
    const cfg = __internal.parseMacOSProxyDump(onlySocks)!;
    expect(cfg.http).toBeNull();
    expect(cfg.https).toBeNull();
    expect(cfg.socks).toMatchObject({ kind: 'socks5', port: 7890 });
  });

  it('PAC', () => {
    const pac = REAL
      .replace('ProxyAutoConfigEnable : 0', 'ProxyAutoConfigEnable : 1')
      .replace('ProxyAutoDiscoveryEnable : 0', 'ProxyAutoConfigURLString : http://wpad.corp/proxy.pac');
    expect(__internal.parseMacOSProxyDump(pac)!.pacUrl).toBe('http://wpad.corp/proxy.pac');
  });

  it('ExcludeSimpleHostnames', () => {
    const cfg = __internal.parseMacOSProxyDump(`${REAL.slice(0, -1)}  ExcludeSimpleHostnames : 1\n}`)!;
    expect(cfg.excludeSimpleHostnames).toBe(true);
  });

  it('完全没开代理 → null (我们一个字节都不该动)', () => {
    expect(__internal.parseMacOSProxyDump('<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n  }\n}')).toBeNull();
  });
});

describe('Windows ProxyServer 解析', () => {
  it('单值形态: http 与 https 都走它, socks 不受影响', () => {
    const cfg = emptyProxyConfig();
    __internal.parseWindowsProxyServer('127.0.0.1:7890', cfg);
    expect(cfg.http).toMatchObject({ host: '127.0.0.1', port: 7890 });
    expect(cfg.https).toMatchObject({ host: '127.0.0.1', port: 7890 });
    expect(cfg.socks).toBeNull();
  });
  it('逐 scheme 形态', () => {
    const cfg = emptyProxyConfig();
    __internal.parseWindowsProxyServer('http=1.1.1.1:80;https=2.2.2.2:8080;socks=3.3.3.3:1080', cfg);
    expect(cfg.http).toMatchObject({ host: '1.1.1.1', port: 80 });
    expect(cfg.https).toMatchObject({ host: '2.2.2.2', port: 8080 });
    expect(cfg.socks).toMatchObject({ kind: 'socks5', host: '3.3.3.3', port: 1080 });
  });
  it('reg query 输出取值', () => {
    const dump = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:7890',
      '    ProxyOverride    REG_SZ    localhost;127.*;<local>',
    ].join('\r\n');
    expect(__internal.regValue(dump, 'ProxyEnable')).toBe('0x1');
    expect(__internal.regValue(dump, 'ProxyServer')).toBe('127.0.0.1:7890');
    expect(__internal.regValue(dump, 'AutoConfigURL')).toBeNull();
  });
});

describe('env 探测', () => {
  const KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const withEnv = <T>(vars: Record<string, string>, fn: () => T): T => {
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, vars);
    try { return fn(); } finally {
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };

  it('ALL_PROXY=socks5 → socks 槽, 不冒充 http/https', () => {
    const cfg = withEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080' }, () => __internal.detectFromEnv())!;
    expect(cfg.socks).toMatchObject({ kind: 'socks5', port: 1080 });
    expect(cfg.http).toBeNull();
    expect(cfg.https).toBeNull();
  });
  it('ALL_PROXY=http → 填 http 与 https 两槽 (它就是这个语义)', () => {
    const cfg = withEnv({ ALL_PROXY: 'http://127.0.0.1:7890' }, () => __internal.detectFromEnv())!;
    expect(cfg.http).not.toBeNull();
    expect(cfg.https).not.toBeNull();
  });
  it('只有 HTTP_PROXY 时 https 槽保持空', () => {
    const cfg = withEnv({ HTTP_PROXY: 'http://127.0.0.1:7890' }, () => __internal.detectFromEnv())!;
    expect(cfg.http).not.toBeNull();
    expect(cfg.https).toBeNull();
  });
  it('NO_PROXY 拆成例外表', () => {
    const cfg = withEnv({ HTTP_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,.corp.com, 10.0.0.0/8' }, () => __internal.detectFromEnv())!;
    expect(cfg.exceptions).toEqual(['localhost', '.corp.com', '10.0.0.0/8']);
  });
  it('都没配 → null', () => {
    expect(withEnv({}, () => __internal.detectFromEnv())).toBeNull();
  });
});

describe('PAC 求解 (node:vm 自研引擎)', () => {
  it('基本 FindProxyForURL + 内置函数', async () => {
    const resolve = compilePac(`
      function FindProxyForURL(url, host) {
        if (isPlainHostName(host)) return "DIRECT";
        if (shExpMatch(host, "*.internal.corp")) return "DIRECT";
        if (dnsDomainIs(host, ".example.com")) return "SOCKS5 127.0.0.1:1080";
        return "PROXY 127.0.0.1:7890; DIRECT";
      }
    `);
    expect(await resolve('http://intranet/', 'intranet')).toBe('DIRECT');
    expect(await resolve('http://git.internal.corp/', 'git.internal.corp')).toBe('DIRECT');
    expect(await resolve('http://a.example.com/', 'a.example.com')).toBe('SOCKS5 127.0.0.1:1080');
    expect(await resolve('http://other.com/', 'other.com')).toBe('PROXY 127.0.0.1:7890; DIRECT');
  });

  it('dnsResolve / isInNet 走预解析缓存', async () => {
    const resolve = compilePac(`
      function FindProxyForURL(url, host) {
        if (isInNet(host, "127.0.0.0", "255.0.0.0")) return "DIRECT";
        return "PROXY p:1";
      }
    `);
    expect(await resolve('http://localhost/', 'localhost')).toBe('DIRECT');
  });

  it('没有 FindProxyForURL 直接抛 (不静默当直连)', () => {
    expect(() => compilePac('var x = 1;')).toThrow(/FindProxyForURL/);
  });

  it('死循环脚本被限时打断, 不挂死主进程', () => {
    expect(() => compilePac('while(true){}')).toThrow();
  });
});
