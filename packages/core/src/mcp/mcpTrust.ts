
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getMcpServerSignature } from './configStore.js';
import type { MCPServerConfig } from '@neoxlabs/platform/utils/config.js';

interface TrustTable { [workspacePath: string]: string[] }

function readTable(): TrustTable {
  try {
    const t = (loadConfig() as { mcpTrust?: unknown }).mcpTrust;
    if (!t || typeof t !== 'object') return {};
    const out: TrustTable = {};
    for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
    }
    return out;
  } catch {
    /* fail-closed: 读不出来就是"什么都没批准过" */
    return {};
  }
}

/** 这个工作区的这台 server 被批准过吗。签名算不出来 (配置残缺) 一律不信。 */
export function isWorkspaceServerTrusted(workDir: string, server: MCPServerConfig): boolean {
  const sig = getMcpServerSignature(server);
  if (!sig) return false;
  return (readTable()[workDir] ?? []).includes(sig);
}

/** 记下用户的批准。返回 false = 这台 server 算不出签名, 没法记 (也就没法信任)。 */
export function trustWorkspaceServer(workDir: string, server: MCPServerConfig): boolean {
  const sig = getMcpServerSignature(server);
  if (!sig) return false;
  try {
    const config = loadConfig() as Record<string, unknown> & { mcpTrust?: TrustTable };
    const table = { ...readTable() };
    const list = new Set(table[workDir] ?? []);
    list.add(sig);
    table[workDir] = [...list];
    config.mcpTrust = table;
    saveConfig(config as never);
    return true;
  } catch (err: any) {
    cliLogger.warn('MCP', `记录信任失败: ${err?.message ?? err}`);
    return false;
  }
}

/** 撤销。整个工作区的批准一次性清掉时不传 server。 */
export function revokeWorkspaceTrust(workDir: string, server?: MCPServerConfig): void {
  try {
    const config = loadConfig() as Record<string, unknown> & { mcpTrust?: TrustTable };
    const table = { ...readTable() };
    if (!server) {
      delete table[workDir];
    } else {
      const sig = getMcpServerSignature(server);
      table[workDir] = (table[workDir] ?? []).filter((s) => s !== sig);
      if (table[workDir].length === 0) delete table[workDir];
    }
    config.mcpTrust = table;
    saveConfig(config as never);
  } catch (err: any) {
    cliLogger.warn('MCP', `撤销信任失败: ${err?.message ?? err}`);
  }
}

export interface TrustSplit<T> {
  /** 可以连的 */
  allowed: T[];
  /** 仓库带的、还没被批准的 —— 调用方要把它们**说给用户听**, 而不是默默丢掉 */
  blocked: T[];
}

/**
 * 按信任把 server 列表分成两拨。
 *
 * 被拦下的**不能静默丢弃**: 用户在仓库里看到 mcp.json 却发现工具没出现, 会以为
 * MCP 坏了。调用方拿到 blocked 要么提示、要么在 /mcp 里列出来让人批。
 */
export function splitByTrust<T extends MCPServerConfig & { scope?: string }>(
  workDir: string,
  servers: T[],
): TrustSplit<T> {
  const allowed: T[] = [];
  const blocked: T[] = [];
  for (const s of servers) {
    /* 用户级的不过闸 —— 那是用户自己加的 */
    if (s.scope !== 'workspace' || isWorkspaceServerTrusted(workDir, s)) allowed.push(s);
    else blocked.push(s);
  }
  return { allowed, blocked };
}
