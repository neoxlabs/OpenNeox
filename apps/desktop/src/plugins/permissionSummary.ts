type SummaryLang = 'zh' | 'en';

/** sensitive 由这里按权限种类判, 渲染端不再靠中文关键词 ('网络' / '写入') 猜哪条要标黄 */
export type PermissionSummary = { text: string; sensitive: boolean };

export function summarizePermissions(perms: any, lang: SummaryLang = 'zh'): PermissionSummary[] {
  const zh = lang === 'zh';
  const out: PermissionSummary[] = [];
  if (!perms || typeof perms !== 'object') return out;
  if (perms.network === true) out.push({ text: zh ? '访问网络 (HTTP)' : 'Network access (HTTP)', sensitive: true });
  if (Array.isArray(perms.tools) && perms.tools.length) {
    /* permissions.tools 是插件面板 (iframe) 能调哪些工具的白名单 (pluginHostHandlers.invokeTool 按它放行) */
    out.push({ text: `${zh ? '面板可调用的工具' : 'Tools its panel can call'}: ${perms.tools.join(', ')}`, sensitive: true });
  }
  if (perms.filesystem) {
    if (Array.isArray(perms.filesystem.read) && perms.filesystem.read.length) {
      out.push({ text: `${zh ? '读取文件' : 'Reads files'}: ${perms.filesystem.read.join(', ')}`, sensitive: false });
    }
    if (Array.isArray(perms.filesystem.write) && perms.filesystem.write.length) {
      out.push({ text: `${zh ? '写入文件' : 'Writes files'}: ${perms.filesystem.write.join(', ')}`, sensitive: true });
    }
  }
  return out;
}

/** connector 的能力声明要用人话进安装页 —— 这是「装之前先看清楚」的核心信息 */
export function summarizeConnectorPermissions(manifest: any, lang: SummaryLang = 'zh'): PermissionSummary[] {
  const c = manifest?.connector;
  if (!c || !Array.isArray(c.permissions)) return [];
  const EFFECT: Record<string, { zh: string; en: string }> = {
    readonly: { zh: '只读', en: 'read-only' },
    writes: { zh: '写入', en: 'writes' },
    destructive: { zh: '不可逆删除', en: 'deletes' },
    costly: { zh: '产生费用', en: 'costs money' },
  };
  return c.permissions.map((p: any) => {
    const r = p?.reason;
    const reason = typeof r === 'string' ? r : ((lang === 'zh' ? r?.zh ?? r?.en : r?.en ?? r?.zh) ?? p?.capability);
    const effect = EFFECT[p?.effect]?.[lang] ?? p?.effect;
    const cost = p?.cost?.approxUsd ? ` · ${lang === 'zh' ? '约' : '~'} $${p.cost.approxUsd}/${p.cost.unit}` : '';
    return { text: `${reason} [${effect}${cost}]`, sensitive: p?.effect !== 'readonly' };
  });
}

export function summarizeComponents(manifest: any, lang: SummaryLang = 'zh'): string[] {
  const zh = lang === 'zh';
  const out: string[] = [];
  if (Array.isArray(manifest?.skills) && manifest.skills.length) out.push(`Skills (${manifest.skills.length})`);
  if (Array.isArray(manifest?.tools) && manifest.tools.length) out.push(`Tools (${manifest.tools.length})`);
  if (manifest?.hooks) out.push(zh ? 'Hooks (工具调用前后执行 shell 命令)' : 'Hooks (shell commands before/after tool calls)');
  if (manifest?.mcpServers && Object.keys(manifest.mcpServers).length) {
    out.push(`MCP Servers (${Object.keys(manifest.mcpServers).length})`);
  }
  if (Array.isArray(manifest?.agents) && manifest.agents.length) out.push(`${zh ? 'Agent 类型' : 'Agent types'} (${manifest.agents.length})`);
  if (Array.isArray(manifest?.commands) && manifest.commands.length) out.push(`${zh ? '斜杠命令' : 'Slash commands'} (${manifest.commands.length})`);
  if (Array.isArray(manifest?.views) && manifest.views.length) out.push(`${zh ? 'UI 面板' : 'UI panels'} (${manifest.views.length})`);
  if (manifest?.authProvider?.id) out.push(`${zh ? '订阅登录' : 'Subscription sign-in'} (${manifest.authProvider.id})`);
  if (Array.isArray(manifest?.connector?.tools) && manifest.connector.tools.length) {
    const n = manifest.connector.tools.length;
    out.push(zh
      ? `平台连接器 (${manifest.connector.namespace} · ${n} 个 Agent 工具)`
      : `Connector (${manifest.connector.namespace} · ${n} agent tool${n === 1 ? '' : 's'})`);
  }
  return out;
}
