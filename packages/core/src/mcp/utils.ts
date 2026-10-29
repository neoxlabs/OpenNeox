import { createHash } from 'crypto';

/**
 * 模型侧工具名的硬约束: OpenAI / Anthropic / Gemini 等都要求 `^[a-zA-Z0-9_-]{1,64}$`
 * (Gemini 还允许点, 但取交集最稳)。
 *
 * MCP 协议本身**不限制**工具名 —— 真实 server 里有 `github.search`、`read file`、
 * 70+ 字符的名字; server id 也来自用户配置或外部导入 (`my server.v2`)。原来直接拼成
 * `mcp__<serverId>__<tool>` 塞进工具表, 只要有一个不合规, **整轮请求**就被 provider
 * 400 拒掉 —— 用户看到的是"加了个 MCP 之后什么都不能问了", 而且报错指不回 MCP。
 *
 * 做法: 非法字符换 `_`; 超过 64 就截断并在尾部挂原始名的短哈希 (保证截断后仍唯一、
 * 且同一个工具每次算出来都一样 —— 名字进历史和 prompt cache, 必须稳定)。
 * 真正调用 server 时用的是闭包里的原名 (clientManager.createTool), 与这里的展示名无关。
 */
export const MAX_PROVIDER_TOOL_NAME_LENGTH = 64;
const PROVIDER_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function sanitizePart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

export function isProviderSafeToolName(name: string): boolean {
  return PROVIDER_TOOL_NAME_RE.test(name);
}

export function formatMcpToolName(serverId: string, toolName: string): string {
  const name = `mcp__${sanitizePart(serverId)}__${sanitizePart(toolName)}`;
  if (name.length <= MAX_PROVIDER_TOOL_NAME_LENGTH) return name;
  const suffix = `_${shortHash(`${serverId}\u0000${toolName}`)}`;
  return name.slice(0, MAX_PROVIDER_TOOL_NAME_LENGTH - suffix.length) + suffix;
}

/**
 * 同一张工具表里名字必须唯一。清洗是有损的 (`a.b` 和 `a_b` 都成 `a_b`, 两台 server 的长名
 * 截断后可能同前缀), 撞名时后来者挂原名哈希 —— 否则工具表里后一个静默覆盖前一个,
 * 模型调 A 实际跑到 B。
 */
export function dedupeMcpToolName(
  name: string,
  serverId: string,
  toolName: string,
  taken: Set<string>,
): string {
  if (!taken.has(name)) return name;
  const suffix = `_${shortHash(`${serverId}\u0000${toolName}`)}`;
  let candidate = name.slice(0, MAX_PROVIDER_TOOL_NAME_LENGTH - suffix.length) + suffix;
  for (let i = 2; taken.has(candidate); i++) {
    const s = `${suffix}_${i}`;
    candidate = name.slice(0, MAX_PROVIDER_TOOL_NAME_LENGTH - s.length) + s;
  }
  return candidate;
}

export function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
  if (!name.startsWith('mcp__')) {
    return null;
  }
  const parts = name.split('__');
  if (parts.length < 3) {
    return null;
  }
  const serverId = parts[1];
  const toolName = parts.slice(2).join('__');
  if (!serverId || !toolName) {
    return null;
  }
  return { serverId, toolName };
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__');
}
