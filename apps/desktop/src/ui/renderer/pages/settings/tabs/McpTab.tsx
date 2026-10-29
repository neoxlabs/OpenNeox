import React, { useState } from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import { useAgentModeVariant } from '../../../hooks/useAgentModeVariant';
import Icons from '../../../components/Icons';
import { McpServerMark } from './McpServerMark';
import { PageTitle, Switch, NeoxButton } from '../../../components/settings-base';
import { McpEditForm } from './McpEditForm';
import { McpDetailView } from './McpDetailView';
import { approveProjectMcpServer } from './mcpApproveServer';
import { McpScanImport } from './McpScanImport';
import { McpPresetGallery, presetNeedsKey, presetToConfig, type McpPreset } from './McpPresets';
import './McpTab.css';

const McpTab: React.FC = () => {
  const ctx = useSettingsContext();
  const { language } = useI18n();
  const zh = language === 'zh';
  /* Work 说人话: "MCP 服务器/启用 MCP"对办公用户是天书 — 用"连接外部服务"讲这页是干嘛的 */
  const { isWork: plain } = useAgentModeVariant();
  /* 同一时间只展开一行 (设计稿: 点哪行哪行展开, 其它收起) */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /* 从本机导入 (Claude Code / Claude Desktop / Cursor / Codex) —— 独占一屏, 跟技能 / 记忆的导入同一套 */
  const [importing, setImporting] = useState(false);
  /* 常用服务正在装的那一个 (hook 也得在下面那些 return 之前) */
  const [presetBusy, setPresetBusy] = useState<string | null>(null);

  if (ctx.viewingMcpServer) {
    return <McpDetailView />;
  }
  if (ctx.showMcpAddForm || ctx.editingMcpServer) {
    return <McpEditForm />;
  }
  if (importing) {
    return (
      <div className="settings-panel-content">
        <div className="mp-titlebar mp-titlebar--back">
          <PageTitle title={zh ? '从本机导入 MCP' : 'Import MCP servers'} />
          <NeoxButton variant="ghost" size="sm" onClick={() => setImporting(false)} leading={<Icons.ChevronLeft />}>
            {zh ? '返回' : 'Back'}
          </NeoxButton>
        </div>
        <McpScanImport zh={zh} onImported={() => { void ctx.loadMcpServers(); }} />
      </div>
    );
  }
  const {
    mcpEnabled, mcpLoading, mcpServers, mcpConnectionStatus, mcpToolCounts, mcpServerTools, mcpLastErrors,
    resetMcpForm, setEditingMcpServer, setShowMcpAddForm,
    handleMcpToggle, handleMcpDisconnect, handleMcpConnect, handleMcpServerToggle,
    handleMcpEdit, handleMcpDelete, loadMcpServers, setMcpLastErrors, setMcpConnectionStatus,
  } = ctx;

  /* 仓库带来的 server: 确认 → 记批准 → 刷新列表 → 连一次 (失败原因落到卡片上) */
  const handleMcpTrust = async (server: any) => {
    const r = await approveProjectMcpServer(server, zh);
    if (r === 'cancelled') return;
    if (r !== 'ok') {
      setMcpLastErrors((p: Record<string, string>) => ({ ...p, [server.id]: r }));
      setMcpConnectionStatus((p: Record<string, string>) => ({ ...p, [server.id]: 'error' }));
      return;
    }
    await loadMcpServers();
    if (server.enabled !== false) await handleMcpConnect(server.id);
  };

  const openAdd = () => { resetMcpForm(); setEditingMcpServer(null); setShowMcpAddForm(true); };

  /* 常用服务: 不要 Key 的直接装 + 连; 要 Key 的打开预填好的表单 */
  const pickPreset = async (p: McpPreset) => {
    if (presetNeedsKey(p)) {
      resetMcpForm();
      setEditingMcpServer(null);
      ctx.setMcpFormId(p.id);
      ctx.setMcpFormName(p.name);
      ctx.setMcpFormTransport(p.url ? 'http' : 'stdio');
      if (p.url) ctx.setMcpFormUrl(p.url);
      else { ctx.setMcpFormCommand(p.command || ''); ctx.setMcpFormArgs((p.args || []).join(' ')); }
      if (p.keys) ctx.setMcpFormEnv(Object.keys(p.keys).map((k) => `${k}=`).join('\n'));
      setShowMcpAddForm(true);
      return;
    }
    setPresetBusy(p.id);
    try {
      const r: any = await window.neox.mcpAdd('user', presetToConfig(p) as any);
      if (r && r.success === false) throw new Error(r.error || 'add failed');
      if (!mcpEnabled) await handleMcpToggle();
      await loadMcpServers();
      await handleMcpConnect(p.id);
    } catch (err) {
      setMcpLastErrors((x: Record<string, string>) => ({ ...x, [p.id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setPresetBusy(null);
    }
  };
  const connected = mcpServers.filter((s: any) => mcpConnectionStatus[s.id] === 'connected');
  const toolTotal = connected.reduce((n: number, s: any) => n + (mcpToolCounts[s.id] || 0), 0);

  return (
    <div className="settings-panel-content">
      <PageTitle
        title={plain ? (zh ? '连接外部服务' : 'Connected Services') : (zh ? 'MCP 服务器' : 'MCP Servers')}
        subtitle={plain
          ? (zh ? '把常用服务接给 Neox，接进来就能在对话里用' : 'Connect the services you use — once connected, use them in chat')
          : (zh ? '给 Agent 接上更多工具：日历、数据库、浏览器……接进来就能在对话里用' : 'Give the agent more tools — calendars, databases, browsers… connect once, use in chat')}
      />

      <div className="mfs mcp3">
        {/* 状态卡: 左边三个数, 右边「启用 MCP」开关 + 添加 / 从本机导入 (原 hero 的控件搬到这里, 一个不少) */}
        <section className={`mcp3-status${mcpEnabled ? '' : ' is-off'}`}>
          <div className="mcp3-status__stats">
            <div className="mcp3-stat"><b>{mcpServers.length}</b><span>{zh ? '个服务器' : 'servers'}</span></div>
            <div className={`mcp3-stat${connected.length ? ' is-live' : ''}`}><b>{connected.length}</b><span>{zh ? '个在线' : 'online'}</span></div>
            <div className="mcp3-stat"><b>{toolTotal}</b><span>{zh ? '个工具' : 'tools'}</span></div>
            {!mcpEnabled && (
              <p className="mcp3-status__off">{zh ? '已关闭，下面的服务器都不会加载' : 'Off — none of the servers below are loaded'}</p>
            )}
          </div>
          <div className="mcp3-status__action">
            <div className="mcp3-status__toggle">
              <span>{plain ? (zh ? '启用外部服务' : 'Enable connected services') : (zh ? '启用 MCP' : 'Enable MCP')}</span>
              <Switch checked={mcpEnabled} aria-label={plain ? (zh ? '启用外部服务' : 'Enable connected services') : (zh ? '启用 MCP' : 'Enable MCP')}
                onChange={() => handleMcpToggle()} />
            </div>
            <div className="mcp3-status__pills">
              <button type="button" className="mcp3-pill" onClick={openAdd}><Icons.Plus />{zh ? '添加' : 'Add'}</button>
              <button type="button" className="mcp3-pill" onClick={() => setImporting(true)}><Icons.Download />{zh ? '从本机导入' : 'Import'}</button>
            </div>
          </div>
        </section>

        {mcpLoading ? (
          <div className="mcp2-loading"><Icons.Loader /><span className="neox-text-shimmer">{zh ? '加载中…' : 'Loading…'}</span></div>
        ) : mcpServers.length === 0 ? (
          <button type="button" className="mcp2-empty" onClick={openAdd}>
            <Icons.Plus />
            <span>
              <b>{plain ? (zh ? '连接第一个服务' : 'Connect your first service') : (zh ? '添加第一个服务器' : 'Add your first server')}</b>
              <em>{zh ? '支持本地命令 (stdio) 和远程地址 (HTTP / SSE)' : 'Local command (stdio) or remote URL (HTTP / SSE)'}</em>
            </span>
          </button>
        ) : (
          <section className="mcp3-list">
            <div className={`mcp3-rows${mcpEnabled ? '' : ' is-off'}`}>
              {mcpServers.map((server: any) => {
                const status: string = mcpConnectionStatus[server.id] || 'disconnected';
                const toolCount = mcpToolCounts[server.id] || 0;
                const open = expandedId === server.id;
                const tools = mcpServerTools[server.id] ?? [];
                const name = server.name || server.id;
                const where = server.transport === 'stdio' ? server.command : server.url;
                const err: string | undefined = mcpLastErrors[server.id];
                /* 仓库 .neox/mcp.json 带来的、还没批准的: 不会被连接, 要用户看过命令后点「批准」 */
                const needsApproval = server.scope === 'workspace' && server.trusted === false;
                const proto = String(server.transport).toUpperCase();
                const transportLabel = server.transport === 'stdio'
                  ? (zh ? '本地命令' : 'Local command')
                  : (zh ? `远程 ${proto}` : `Remote ${proto}`);
                const scopeLabel = server.scope === 'workspace' ? (zh ? '仅当前项目' : 'This project') : (zh ? '所有项目' : 'All projects');

                /* 状态 chip: 待批准 / 已连接 / 连接中 / 连接失败 / 未连接 / 已停用 */
                let chip: React.ReactNode;
                if (needsApproval && status !== 'error') {
                  chip = <span className="mcp3-chip is-warn" title={zh ? '项目自带 · 未批准' : 'From this project · not approved'}>{zh ? '待批准' : 'Pending'}</span>;
                } else if (status === 'connected') {
                  chip = <span className="mcp3-chip is-ok">{zh ? '已连接' : 'Connected'}</span>;
                } else if (status === 'connecting') {
                  chip = <span className="mcp3-chip is-idle"><span className="mcp3-spin"><Icons.Loader /></span>{zh ? '连接中' : 'Connecting'}</span>;
                } else if (status === 'error') {
                  chip = <span className="mcp3-chip is-bad" title={err}>{zh ? '连接失败' : 'Failed'}</span>;
                } else {
                  chip = <span className="mcp3-chip is-idle">{server.enabled ? (zh ? '未连接' : 'Not connected') : (zh ? '已停用' : 'Disabled')}</span>;
                }

                return (
                  <div key={server.id} className={`mcp3-row is-${status}${server.enabled ? '' : ' is-disabled'}${open ? ' is-open' : ''}`}>
                    <div className="mcp3-row__head">
                      <button type="button" className="mcp3-row__main" aria-expanded={open}
                        onClick={() => setExpandedId(open ? null : server.id)}>
                        <McpServerMark name={name} hint={[server.command, ...(server.args || []), server.url].filter(Boolean).join(' ')} />
                        <span className="mcp3-row__id">
                          <span className="mcp3-row__name">{name}</span>
                          <span className="mcp3-row__meta" title={where}>{transportLabel} · {scopeLabel}</span>
                        </span>
                        {chip}
                        {status === 'connected' && (
                          <span className="mcp3-row__count">{toolCount > 0 ? (zh ? `${toolCount} 个工具` : `${toolCount} tools`) : (zh ? '没有工具' : 'No tools')}</span>
                        )}
                        <Icons.ChevronDown className="mcp3-row__chev" width={12} height={12} />
                      </button>
                      <div className="mcp3-row__side">
                        {status === 'error' && !needsApproval && server.enabled && (
                          <button type="button" className="mcp3-link" onClick={() => handleMcpConnect(server.id)}>{zh ? '重试' : 'Retry'}</button>
                        )}
                        {needsApproval && (
                          <button type="button" className="mcp3-outline" onClick={() => handleMcpTrust(server)}>{zh ? '批准' : 'Approve'}</button>
                        )}
                        <Switch checked={!!server.enabled} aria-label={zh ? `启用 ${name}` : `Enable ${name}`} onChange={() => handleMcpServerToggle(server)} />
                      </div>
                    </div>

                    {open && (
                      <div className="mcp3-row__detail">
                        <div className="mcp3-row__tools">
                          {status === 'error' && err && <p className="mcp3-row__err">{err}</p>}
                          <span className="mcp3-row__label">{zh ? '已启用的工具' : 'Enabled tools'}</span>
                          {status === 'connected' && tools.length > 0 ? (
                            <div className="mcp3-chips">
                              {tools.slice(0, 3).map((tool: any, i: number) => {
                                const tname = tool?.name ?? `tool-${i}`;
                                const first = String(tool?.description ?? '').split('\n')[0];
                                return <code key={tname} title={first || tname}>{tname}</code>;
                              })}
                              {tools.length > 3 && <span className="mcp3-chips__more">+{tools.length - 3}</span>}
                            </div>
                          ) : (
                            <span className="mcp3-row__hint">{status === 'connected' ? (zh ? '没有工具' : 'No tools') : (zh ? '连接后显示工具' : 'Shown after connecting')}</span>
                          )}
                        </div>
                        <div className="mcp3-row__actions">
                          <button type="button" onClick={() => handleMcpEdit(server)}>{zh ? '编辑' : 'Edit'}</button>
                          {!needsApproval && server.enabled && (status === 'connected' ? (
                            <button type="button" onClick={() => handleMcpDisconnect(server.id)}>{zh ? '断开' : 'Disconnect'}</button>
                          ) : (
                            <button type="button" onClick={() => handleMcpConnect(server.id)} disabled={status === 'connecting'}>{zh ? '连接' : 'Connect'}</button>
                          ))}
                          <button type="button" onClick={() => ctx.setViewingMcpServer(server)}>{zh ? '查看详情' : 'Details'}</button>
                          <button type="button" className="is-danger" onClick={() => handleMcpDelete(server)}>{zh ? '删除' : 'Delete'}</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mcp3-foot">
              <button type="button" className="mcp3-add" onClick={openAdd}>
                <Icons.Plus />
                <span><b>{zh ? '添加服务器' : 'Add server'}</b> · {zh ? '支持本地命令和远程地址 (HTTP / SSE)' : 'Local command or remote URL (HTTP / SSE)'}</span>
              </button>
            </div>
          </section>
        )}

        {/* 常用服务放在自己装的那些下面: 第一次来的人一眼看到, 装多了也不把自己的列表挤到底下 */}
        <McpPresetGallery
          zh={zh}
          installedIds={new Set(mcpServers.map((s: any) => s.id))}
          busyId={presetBusy}
          onPick={(p) => { void pickPreset(p); }}
        />
      </div>
    </div>
  );
};

export default McpTab;
