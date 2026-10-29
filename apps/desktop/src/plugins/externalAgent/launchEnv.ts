
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EXTERNAL_AGENT_CREDENTIALS,
  type PluginExternalAgentDefinition,
} from '@neoxlabs/platform/shared/plugin-external-agent.js';

export type CredentialResolver = (hosts: readonly string[]) => { apiKey: string; baseUrl?: string } | null;

/* 宿主注入: 用户登录 shell 的完整环境 (shellEnv 缓存) + 按域名找 Neox 里已配置服务商的 key。
 * 不注入时退回 process.env / 不注入凭据 —— 单测和 CLI 走这条。 */
let hostEnv: () => NodeJS.ProcessEnv = () => process.env;
let credentialResolver: CredentialResolver | null = null;

export function setExternalAgentLaunchHooks(hooks: { getEnv?: () => NodeJS.ProcessEnv; resolveCredential?: CredentialResolver }): void {
  if (hooks.getEnv) hostEnv = hooks.getEnv;
  if (hooks.resolveCredential) credentialResolver = hooks.resolveCredential;
}

/**
 * 子进程环境: **继承用户环境** (登录 shell 的, 不是 Electron 从 launchctl 拿到的那份),
 * 只剥掉 Neox 自己的 `NEOX_*`。
 *
 *   外部 agent 是用户自己装、自己配的 CLI —— 它接哪个网关、认哪个变量名是用户的事,
 *   剥光环境等于把用户配好的 codex 弄坏。NEOX_* 里有本机 server token 之类只属于我们的东西。
 */
export function buildAgentEnv(agent: PluginExternalAgentDefinition, workdir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...hostEnv() };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NEOX_')) delete env[key];
  }
  /* PWD 必须跟 cwd 一致: OpenCode 认 PWD 不认 cwd —— 继承来的 PWD 是 Neox 的启动目录,
   * 派到 worktree 的任务会把文件写进那里。 */
  if (workdir) env.PWD = workdir;
  /* 外部 agent 是非交互跑的, 明说一声免得它试图画 TUI */
  env.TERM = 'dumb';

  /* 用户自己设了就用用户的; 没设才从 Neox 里同厂商的服务商取 */
  for (const id of agent.credentials ?? []) {
    const spec = EXTERNAL_AGENT_CREDENTIALS[id];
    if (!spec || env[spec.env]) continue;
    const cred = credentialResolver?.(spec.hosts);
    if (!cred?.apiKey) continue;
    env[spec.env] = cred.apiKey;
    if (spec.baseUrlEnv && !env[spec.baseUrlEnv] && cred.baseUrl) env[spec.baseUrlEnv] = cred.baseUrl;
  }
  return env;
}

// ── Node 运行时 ────────────────────────────────────────────────────────────

function parseVersion(v: string): number[] | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(v: string, min: string): boolean {
  const a = parseVersion(v);
  if (!a) return false;
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** 在 PATH 里找可执行文件的绝对路径 */
export function resolveOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, command);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return fs.realpathSync(full);
    } catch { /* 下一个 */ }
  }
  return null;
}

function isNodeScript(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(128);
    const n = fs.readSync(fd, buf, 0, 128, 0);
    fs.closeSync(fd);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
    return /^#!.*\bnode\b/.test(first);
  } catch {
    return false;
  }
}

/** 本机常见的 node 安装位置 —— 只找用户已经装了的 */
function nodeCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = os.homedir();
  const out = new Set<string>();
  const onPath = resolveOnPath('node', env);
  if (onPath) out.add(onPath);
  const globDirs: Array<[string, string]> = [
    [path.join(home, '.nvm', 'versions', 'node'), 'bin/node'],
    [path.join(home, '.local', 'share', 'fnm', 'node-versions'), 'installation/bin/node'],
    [path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), 'installation/bin/node'],
    [path.join(home, '.volta', 'tools', 'image', 'node'), 'bin/node'],
    [path.join(home, '.asdf', 'installs', 'nodejs'), 'bin/node'],
    [path.join(home, '.local', 'share', 'mise', 'installs', 'node'), 'bin/node'],
    ['/opt/homebrew/opt', 'bin/node'],
    ['/usr/local/opt', 'bin/node'],
  ];
  for (const [dir, rel] of globDirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (dir.endsWith('/opt') && !/^node(@\d+)?$/.test(name)) continue;
      out.add(path.join(dir, name, rel));
    }
  }
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) out.add(p);
  try {
    for (const name of fs.readdirSync(path.join(home, '.local', 'share'))) {
      if (/^node/.test(name)) out.add(path.join(home, '.local', 'share', name, 'bin', 'node'));
    }
  } catch { /* 没这个目录 */ }
  return [...out].filter((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
}

const nodeVersionCache = new Map<string, string | null>();
function nodeVersion(bin: string): string | null {
  if (nodeVersionCache.has(bin)) return nodeVersionCache.get(bin)!;
  let v: string | null = null;
  try { v = execFileSync(bin, ['-v'], { timeout: 5000, encoding: 'utf8' }).trim(); } catch { v = null; }
  nodeVersionCache.set(bin, v);
  return v;
}

export type Launch =
  | { ok: true; file: string; prefixArgs: string[]; note?: string }
  | { ok: false; reason: string };

/**
 * 决定怎么起这个命令。
 *
 *   没声明 runtime.node → 原样按命令名起 (走 PATH)。
 *   声明了且它是 node 脚本 → PATH 上的 node 够新就原样起; 不够新就在本机找一个够新的,
 *   用它跑同一个脚本; 一个都没有就**直说**要装哪个版本 (不去跑一个注定静默退出的进程)。
 */
export function resolveLaunch(agent: PluginExternalAgentDefinition, env: NodeJS.ProcessEnv): Launch {
  const min = agent.runtime?.node;
  if (!min || process.platform === 'win32') return { ok: true, file: agent.command, prefixArgs: [] };

  const script = resolveOnPath(agent.command, env);
  if (!script || !isNodeScript(script)) return { ok: true, file: agent.command, prefixArgs: [] };

  const defaultNode = resolveOnPath('node', env);
  const defaultVersion = defaultNode ? nodeVersion(defaultNode) : null;
  if (defaultVersion && versionAtLeast(defaultVersion, min)) return { ok: true, file: agent.command, prefixArgs: [] };

  let best: { bin: string; version: string } | null = null;
  for (const bin of nodeCandidates(env)) {
    const v = nodeVersion(bin);
    if (!v || !versionAtLeast(v, min)) continue;
    if (!best || versionAtLeast(v, best.version.replace(/^v/, ''))) best = { bin, version: v };
  }
  if (best) {
    return { ok: true, file: best.bin, prefixArgs: [script], note: `node ${best.version} (默认 ${defaultVersion ?? '无'} 低于 ${min})` };
  }
  return {
    ok: false,
    reason: `\`${agent.command}\` 需要 Node.js ${min} 以上，本机默认是 ${defaultVersion ?? '未安装'}，也没找到别的够新的版本。`
      + `装一个即可（任选其一）：brew install node@24 · nvm install 24 · fnm install 24。装好后不用改默认版本，Neox 会自己找到。`,
  };
}

// ── 接口预检 ───────────────────────────────────────────────────────────────

function readJsonUnderHome(file: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), file.slice(2)), 'utf8')); } catch { return undefined; }
}

/** CLI 配置里的模型接口地址; path 里 {key} 取根上的字段值 */
export function readEndpoint(agent: PluginExternalAgentDefinition): string | undefined {
  const spec = agent.endpointFrom;
  if (!spec) return undefined;
  const json = readJsonUnderHome(spec.file);
  if (!json || typeof json !== 'object') return undefined;
  const p = spec.path.replace(/\{(\w+)\}/g, (_, k) => String(json[k] ?? ''));
  let cur: any = json;
  for (const seg of p.split('.')) cur = cur == null ? undefined : cur[seg];
  return typeof cur === 'string' && /^https?:\/\//.test(cur) ? cur : undefined;
}

/**
 * 起进程前连一下它要用的接口。只在**确定连不上**时返回原因:
 *   · 连接被拒 (那个端口没人听) —— 本地转发没开、地址写错
 *   · 域名解析失败且没配代理 (配了代理时本机可能本来就不解析外网, 不能据此判死)
 * 超时一律放行 —— 慢不等于不通, 交给 CLI 自己。
 */
export async function probeEndpoint(url: string, env: NodeJS.ProcessEnv, timeoutMs = 2500): Promise<string | null> {
  let host = '';
  let port = 0;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    return null;
  }
  const net = await import('node:net');
  const hasProxy = !!(env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy);
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (r: string | null) => { sock.destroy(); resolve(r); };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); done(null); });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ECONNREFUSED') return done(`连不上它配置的模型接口 ${url}（连接被拒，那个地址上没有服务在听）`);
      if (err.code === 'ENOTFOUND' && !hasProxy) return done(`连不上它配置的模型接口 ${url}（域名解析失败）`);
      done(null);
    });
  });
}

// ── 默认模型 ───────────────────────────────────────────────────────────────

/** 从 CLI 自己的配置里取默认模型; 取不到返回 undefined (交给 CLI 自己的默认值) */
export function readDefaultModel(agent: PluginExternalAgentDefinition): string | undefined {
  const spec = agent.defaultModelFrom;
  if (!spec) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(path.join(os.homedir(), spec.file.slice(2)), 'utf8'));
  } catch {
    return undefined;
  }
  let re: RegExp | null = null;
  try { re = spec.match ? new RegExp(spec.match) : null; } catch { re = null; }
  for (const p of spec.paths) {
    let cur: any = json;
    for (const seg of p.split('.')) cur = cur == null ? undefined : cur[seg];
    if (typeof cur === 'string' && cur.trim() && (!re || re.test(cur))) return cur.trim();
  }
  return undefined;
}
