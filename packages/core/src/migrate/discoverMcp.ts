
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { MCPServerConfig } from '@neoxlabs/platform/utils/config.js';
import { parseTomlSections } from './tomlSections.js';

export interface ExternalMcpCandidate {
  /** 归一化后的 Neox server id */
  id: string;
  /** 源文件里的原始名字 */
  sourceName: string;
  /** 'Claude Code' / 'Codex' / 'Cursor' / 'Claude Desktop' */
  source: string;
  /** 这条是从哪个文件读出来的 —— 让用户能自己去核对 */
  sourcePath: string;
  /** 只对 Claude Code 的 per-project 条目有值 */
  sourceProject?: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** 源里显式关掉的 (Codex 的 enabled = false) —— 照样列出来, 但默认不勾 */
  disabledAtSource: boolean;
  /** ~/.neox 里已经有同 id 的了 */
  alreadyImported: boolean;
  /** env 里带值的 key —— 让用户导入前看清自己要带过来什么秘密 */
  envKeys: string[];
}

export function inferRemoteMcpTransport(type: unknown, url: string): 'sse' | 'http' {
  const t = typeof type === 'string' ? type.toLowerCase().replace(/[-_\s]/g, '') : '';
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamablehttp') return 'http';
  try {
    if (/\/sse\/?$/i.test(new URL(url).pathname)) return 'sse';
  } catch { /* url 不合法: 交给连接时报错, 这里只决定协议 */ }
  return 'http';
}

/** 跟 SkillRegistry.generateSkillId 一个思路: 稳定、可读、不撞 */
export function normalizeMcpId(name: string): string {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'mcp-server';
}

function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    /* 坏 JSON 不该让整个迁移扫描失败 —— 这一个源跳过, 其余照扫 */
    return null;
  }
}

/**
 * `{ "name": { command, args, env } }` / `{ "name": { url } }` 这种形状 ——
 * Claude Code / Cursor / Claude Desktop 三家共用。
 */
function fromMcpServersMap(
  map: unknown,
  source: string,
  sourcePath: string,
  sourceProject: string | undefined,
  out: ExternalMcpCandidate[],
): void {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  for (const [name, rawCfg] of Object.entries(map as Record<string, unknown>)) {
    if (!rawCfg || typeof rawCfg !== 'object') continue;
    const cfg = rawCfg as Record<string, unknown>;

    const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
    const command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
    if (!url && !command) continue;   /* 既没命令也没 URL, 认不出是什么 —— 不猜 */

    const env: Record<string, string> = {};
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
    }
    const args = Array.isArray(cfg.args)
      ? cfg.args.filter((a): a is string => typeof a === 'string')
      : undefined;

    out.push({
      id: normalizeMcpId(name),
      sourceName: name,
      source,
      sourcePath,
      sourceProject,
      transport: url ? inferRemoteMcpTransport(cfg.type ?? cfg.transport, url) : 'stdio',
      command: command || undefined,
      args,
      env: Object.keys(env).length ? env : undefined,
      url: url || undefined,
      /* 这三家的形状里 disabled 不是统一字段, 一律当启用 */
      disabledAtSource: cfg.enabled === false,
      alreadyImported: false,     /* 由 discoverExternalMcpServers 统一填 */
      envKeys: Object.keys(env),
    });
  }
}

/** Codex: `[mcp_servers.<name>]` + 可选的 `[mcp_servers.<name>.env]` */
function fromCodexToml(file: string, out: ExternalMcpCandidate[]): void {
  let text: string;
  try {
    if (!fs.existsSync(file)) return;
    text = fs.readFileSync(file, 'utf-8');
  } catch { return; }

  const sections = parseTomlSections(text);
  for (const [section, kv] of sections) {
    const m = /^mcp_servers\.([^.]+)$/.exec(section);
    if (!m) continue;
    const name = m[1].replace(/^["']|["']$/g, '');

    const url = typeof kv.url === 'string' ? kv.url.trim() : '';
    const command = typeof kv.command === 'string' ? kv.command.trim() : '';
    if (!url && !command) continue;

    const env: Record<string, string> = {};
    const envSection = sections.get(`${section}.env`);
    if (envSection) {
      for (const [k, v] of Object.entries(envSection)) {
        if (typeof v === 'string') env[k] = v;
      }
    }

    out.push({
      id: normalizeMcpId(name),
      sourceName: name,
      source: 'Codex',
      sourcePath: file,
      transport: url ? inferRemoteMcpTransport(kv.type ?? kv.transport, url) : 'stdio',
      command: command || undefined,
      args: Array.isArray(kv.args) ? (kv.args as string[]) : undefined,
      env: Object.keys(env).length ? env : undefined,
      url: url || undefined,
      disabledAtSource: kv.enabled === false,
      alreadyImported: false,
      envKeys: Object.keys(env),
    });
  }
}

/**
 * 扫出所有可导入的 MCS server。
 *
 *   existingIds: 调用方传 Neox 现有的 server id (来自 listMcpServers), 用来标
 *   alreadyImported。**不在这里自己去读 Neox 的配置** —— 那会让本模块依赖 configStore,
 *   而 configStore 的 listMcpServers 需要 workDir, 由调用方决定作用域更合适。
 */
export function discoverExternalMcpServers(
  existingIds: Iterable<string> = [],
  homeOverride?: string,
): ExternalMcpCandidate[] {
  const home = homeOverride ?? os.homedir();
  const out: ExternalMcpCandidate[] = [];

  /* 1) Claude Code —— 全局 + 每个项目各一份 */
  const claudeJsonPath = path.join(home, '.claude.json');
  const claudeJson = readJson(claudeJsonPath);
  if (claudeJson) {
    fromMcpServersMap(claudeJson.mcpServers, 'Claude Code', claudeJsonPath, undefined, out);
    const projects = claudeJson.projects;
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      for (const [projPath, projCfg] of Object.entries(projects as Record<string, any>)) {
        fromMcpServersMap(projCfg?.mcpServers, 'Claude Code', claudeJsonPath, projPath, out);
      }
    }
  }

  /* 2) Claude Desktop (macOS 路径; 其它平台没有这个文件, readJson 直接返 null) */
  const desktopCfg = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  fromMcpServersMap(readJson(desktopCfg)?.mcpServers, 'Claude Desktop', desktopCfg, undefined, out);

  /* 3) Cursor */
  const cursorCfg = path.join(home, '.cursor', 'mcp.json');
  fromMcpServersMap(readJson(cursorCfg)?.mcpServers, 'Cursor', cursorCfg, undefined, out);

  /* 4) Codex */
  fromCodexToml(path.join(home, '.codex', 'config.toml'), out);

  /* 去重: 同一个 server 在多处配过 (很常见 —— 用户两边都装了)。
   * 先扫到的赢, 顺序 = 上面的 roots 顺序。跟 discoverExternalSkills 同一条规则。 */
  const seen = new Set<string>();
  const existing = new Set(Array.from(existingIds, (x) => String(x)));
  const deduped: ExternalMcpCandidate[] = [];
  for (const c of out) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    c.alreadyImported = existing.has(c.id);
    deduped.push(c);
  }
  return deduped.sort((a, b) => a.id.localeCompare(b.id));
}

/** 候选 -> 可直接交给 addMcpServer 的配置 */
export function toMcpServerConfig(c: ExternalMcpCandidate): MCPServerConfig {
  return {
    id: c.id,
    name: c.sourceName,
    transport: c.transport as MCPServerConfig['transport'],
    command: c.command,
    args: c.args,
    env: c.env,
    url: c.url,
    /* 源里关着的, 导过来也保持关着 —— 用户没打算跑它 */
    enabled: !c.disabledAtSource,
    autoConnect: false,
  };
}
