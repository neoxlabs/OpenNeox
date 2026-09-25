/**
 * 系统代理探测按平台完整读取并保持同步。主进程必须在发出第一个 fetch 之前安装
 * dispatcher，因此探测使用同步系统调用，避免初始化请求与代理安装之间出现异步窗口。
 *
 * 覆盖范围:
 *   macOS   scutil --proxy   HTTP / HTTPS / SOCKS / PAC / ExceptionsList / ExcludeSimpleHostnames
 *   Windows 注册表 HKCU Internet Settings  ProxyEnable / ProxyServer (逐 scheme) /
 *           ProxyOverride / AutoConfigURL, 再兜底 netsh winhttp
 *   Linux   env 为主 (发行版惯例), 补 GNOME gsettings (manual / auto 两种 mode)
 *   全平台 env: HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY (含 socks5:// 写法)
 */

import { execFileSync } from 'node:child_process';
import {
  emptyProxyConfig,
  hasAnyProxy,
  parseProxyUrl,
  proxyEnvFingerprint,
  PROXY_ENV_SYNTHETIC_MARKER,
  type ProxyEndpoint,
  type SystemProxyConfig,
} from './types.js';

function run(cmd: string, args: string[], timeout = 2500): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

function splitList(raw: string | undefined | null, seps = /[,;]/): string[] {
  if (!raw) return [];
  return raw.split(seps).map((s) => s.trim()).filter(Boolean);
}

/* ────────────────────────────── env ────────────────────────────── */

/**
 * 环境变量. 优先级高于系统设置 —— 用户在 .zshrc 里 export 是**更明确**的意图,
 * curl / git / npm 也都是这个顺序。
 *
 * ALL_PROXY 按它的实际语义处理: 它是"没单独配的 scheme 走这里", 值可以是
 * socks5:// 也可以是 http://。所以 socks 型进 socks 槽, http 型同时填 http/https 槽。
 */
function detectFromEnv(): SystemProxyConfig | null {
  const cfg = emptyProxyConfig();
  const httpRaw = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsRaw = process.env.HTTPS_PROXY || process.env.https_proxy;
  const allRaw = process.env.ALL_PROXY || process.env.all_proxy;

  /* 这几个值是我们自己转发给子进程/worker 的副本 → 不是"用户的明确意图", 跳过 env 这一层,
   * 让探测继续往下读真正的系统设置。理由见 types.ts 的 PROXY_ENV_SYNTHETIC_MARKER。 */
  const marker = process.env[PROXY_ENV_SYNTHETIC_MARKER];
  if (marker && marker === proxyEnvFingerprint(httpRaw ?? '', httpsRaw ?? '', allRaw ?? '')) {
    return null;
  }

  cfg.http = parseProxyUrl(httpRaw);
  cfg.https = parseProxyUrl(httpsRaw);

  const all = parseProxyUrl(allRaw);
  if (all) {
    if (all.kind === 'socks4' || all.kind === 'socks5') {
      cfg.socks = all;
    } else {
      if (!cfg.http) cfg.http = all;
      if (!cfg.https) cfg.https = all;
    }
  }
  /* HTTP_PROXY=socks5://... 也是常见写法 (Clash 的教程里就有): 留在原槽即可 —— dispatcher
   * 按 endpoint.kind 建通道, 不按槽位。这样它只对被指定的那个 scheme 生效, 不外溢。 */

  if (!hasAnyProxy(cfg)) return null;
  cfg.source = 'env';
  cfg.exceptions = splitList(process.env.NO_PROXY || process.env.no_proxy);
  /* NO_PROXY 里 `*` 表示全部直连; `<local>` 少见但有人写 —— 交给 bypass 层认 */
  return cfg;
}

/* ────────────────────────────── macOS ────────────────────────────── */

/** 解析 `scutil --proxy` 输出；纯函数便于用固定文本覆盖平台字段。 */
function parseMacOSProxyDump(out: string): SystemProxyConfig | null {
  const num = (key: string): number | null => {
    const m = out.match(new RegExp(`${key}\\s*:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const str = (key: string): string | null => {
    const m = out.match(new RegExp(`${key}\\s*:\\s*(\\S+)`));
    return m ? m[1] : null;
  };
  const channel = (prefix: 'HTTP' | 'HTTPS' | 'SOCKS'): ProxyEndpoint | null => {
    if (num(`${prefix}Enable`) !== 1) return null;
    const host = str(`${prefix}Proxy`);
    const port = num(`${prefix}Port`);
    if (!host || !port) return null;
    return { kind: prefix === 'SOCKS' ? 'socks5' : 'http', host, port };
  };

  const cfg = emptyProxyConfig();
  cfg.http = channel('HTTP');
  cfg.https = channel('HTTPS');
  cfg.socks = channel('SOCKS');
  if (num('ProxyAutoConfigEnable') === 1) {
    cfg.pacUrl = str('ProxyAutoConfigURLString');
  }
  if (!hasAnyProxy(cfg)) return null;

  cfg.source = 'system';
  cfg.excludeSimpleHostnames = num('ExcludeSimpleHostnames') === 1;
  /* ExceptionsList : <array> { 0 : *.local  1 : 169.254/16 } */
  const block = out.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  cfg.exceptions = [...block.matchAll(/\d+\s*:\s*(\S+)/g)].map((m) => m[1]);
  return cfg;
}

function detectMacOS(): SystemProxyConfig | null {
  const out = run('scutil', ['--proxy']);
  if (!out) return null;
  return parseMacOSProxyDump(out);
}

/* ────────────────────────────── Windows ────────────────────────────── */

const WIN_INET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** `reg query` 输出里取一个值: `    ProxyServer    REG_SZ    127.0.0.1:7890` */
function regValue(dump: string, name: string): string | null {
  const m = dump.match(new RegExp(`^\\s*${name}\\s+REG_[A-Z_]+\\s+(.*)$`, 'mi'));
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/**
 * ProxyServer 有两种形态:
 *   "127.0.0.1:7890" —— 全 scheme 同一个
 *   "http=1.1.1.1:80;https=2.2.2.2:80;socks=3.3.3.3:1080" —— 逐 scheme
 */
function parseWindowsProxyServer(raw: string, cfg: SystemProxyConfig): void {
  if (raw.includes('=')) {
    for (const part of splitList(raw, /;/)) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const scheme = part.slice(0, eq).trim().toLowerCase();
      const value = part.slice(eq + 1).trim();
      if (!value) continue;
      if (scheme === 'http') cfg.http = parseProxyUrl(value, 'http');
      else if (scheme === 'https') cfg.https = parseProxyUrl(value, 'http');
      else if (scheme === 'socks') cfg.socks = parseProxyUrl(value, 'socks5');
    }
    return;
  }
  /* 单值: IE/WinINET 语义是 http 与 https 都走它 (socks 需显式 socks= 才有) */
  const ep = parseProxyUrl(raw, 'http');
  cfg.http = ep;
  cfg.https = ep;
}

function detectWindows(): SystemProxyConfig | null {
  const cfg = emptyProxyConfig();
  const dump = run('reg', ['query', WIN_INET_KEY]);
  if (dump) {
    const enableRaw = regValue(dump, 'ProxyEnable');
    /* REG_DWORD 显示成 0x1 / 0x0 */
    const enabled = enableRaw ? Number.parseInt(enableRaw, 16) === 1 || enableRaw === '1' : false;
    const server = regValue(dump, 'ProxyServer');
    if (enabled && server) parseWindowsProxyServer(server, cfg);
    const autoConfig = regValue(dump, 'AutoConfigURL');
    if (autoConfig) cfg.pacUrl = autoConfig;
    const override = regValue(dump, 'ProxyOverride');
    if (override) {
      const items = splitList(override, /;/);
      cfg.exceptions = items.filter((s) => s.toLowerCase() !== '<local>');
      cfg.excludeSimpleHostnames = items.some((s) => s.toLowerCase() === '<local>');
    }
  }

  /* 用户没在「设置 → 网络和 Internet → 代理」配, 但机器有 WinHTTP 级代理 (企业常见) */
  if (!hasAnyProxy(cfg)) {
    const winhttp = run('netsh', ['winhttp', 'show', 'proxy']);
    /* 输出: `Proxy Server(s) :  127.0.0.1:7890` / `Bypass List:  <local>` (语言随系统, 所以按冒号后取值) */
    const server = winhttp?.match(/^[^\r\n:]*Proxy[^\r\n:]*:\s*(\S+)\s*$/mi)?.[1];
    if (server && !/direct/i.test(server)) {
      parseWindowsProxyServer(server, cfg);
      const bypass = winhttp?.match(/^[^\r\n:]*Bypass[^\r\n:]*:\s*(.+)$/mi)?.[1] ?? '';
      const items = splitList(bypass, /[;,\s]/);
      cfg.exceptions = items.filter((s) => s.toLowerCase() !== '<local>');
      cfg.excludeSimpleHostnames = items.some((s) => s.toLowerCase() === '<local>');
    }
  }

  if (!hasAnyProxy(cfg)) return null;
  cfg.source = 'system';
  return cfg;
}

/* ────────────────────────────── Linux (GNOME) ────────────────────────────── */

function gsettings(key: string, schema = 'org.gnome.system.proxy'): string | null {
  const out = run('gsettings', ['get', schema, key], 1500);
  if (out === null) return null;
  return out.trim().replace(/^'|'$/g, '');
}

function detectLinux(): SystemProxyConfig | null {
  const mode = gsettings('mode');
  if (!mode) return null;
  const cfg = emptyProxyConfig();
  if (mode === 'auto') {
    const url = gsettings('autoconfig-url');
    if (url) cfg.pacUrl = url;
  } else if (mode === 'manual') {
    const pick = (schema: string, kind: 'http' | 'socks5'): ProxyEndpoint | null => {
      const host = gsettings('host', schema);
      const port = Number(gsettings('port', schema) ?? '0');
      if (!host || !Number.isInteger(port) || port <= 0) return null;
      return { kind, host, port };
    };
    cfg.http = pick('org.gnome.system.proxy.http', 'http');
    cfg.https = pick('org.gnome.system.proxy.https', 'http');
    cfg.socks = pick('org.gnome.system.proxy.socks', 'socks5');
    const ignore = gsettings('ignore-hosts');
    if (ignore) {
      /* 形如 ['localhost', '127.0.0.0/8'] */
      cfg.exceptions = [...ignore.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    }
  }
  if (!hasAnyProxy(cfg)) return null;
  cfg.source = 'system';
  return cfg;
}

/* ────────────────────────────── 总入口 ────────────────────────────── */

/**
 * 探测当前系统代理配置. **同步**.
 * env 优先于系统设置; 都没有则返回 source='none' 的空配置 (调用方据此完全不干预网络)。
 */
export function detectSystemProxy(): SystemProxyConfig {
  const fromEnv = detectFromEnv();
  if (fromEnv) return fromEnv;
  let fromSystem: SystemProxyConfig | null = null;
  if (process.platform === 'darwin') fromSystem = detectMacOS();
  else if (process.platform === 'win32') fromSystem = detectWindows();
  else fromSystem = detectLinux();
  return fromSystem ?? emptyProxyConfig();
}

export const __internal = { detectFromEnv, detectMacOS, parseMacOSProxyDump, detectWindows, detectLinux, parseWindowsProxyServer, regValue };
