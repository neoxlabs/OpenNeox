import React from 'react';
import { confirmAsync } from '../../../components/confirmEvents';
import type { MCPServerEntry } from '../settingsPageTypes';

export async function approveProjectMcpServer(server: MCPServerEntry, zh: boolean): Promise<'ok' | 'cancelled' | string> {
  const what = server.transport === 'stdio'
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
    : (server.url ?? '');
  const envKeys = Object.keys(server.env ?? {});
  const name = server.name || server.id;
  const ok = await confirmAsync({
    title: zh ? '批准这个项目自带的服务器？' : 'Approve this project\'s server?',
    variant: 'danger',
    message: (
      <>
        {zh
          ? <>「{name}」来自当前项目的 .neox/mcp.json，不是你自己添加的。批准后，在这个项目里会运行：</>
          : <>"{name}" comes from this project's .neox/mcp.json, not from you. Once approved, this project will run:</>}
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '8px 0', fontSize: 12 }}>{what}</pre>
        {envKeys.length > 0 && <div style={{ fontSize: 12, opacity: 0.75 }}>{zh ? '环境变量：' : 'Environment: '}{envKeys.join(', ')}</div>}
        <div style={{ marginTop: 8 }}>{zh ? '只在你信任这个项目时批准。' : 'Only approve if you trust this project.'}</div>
      </>
    ),
    confirmLabel: zh ? '批准并连接' : 'Approve & connect',
  });
  if (!ok) return 'cancelled';
  try {
    const r = await window.neox.mcpTrust(server.id, true);
    return r?.success ? 'ok' : (r?.error || (zh ? '批准失败' : 'Approval failed'));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
