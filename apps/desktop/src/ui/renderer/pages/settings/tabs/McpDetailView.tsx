import React from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import {
  PageTitle,
  Section,
  SectionTitle,
  SettingsCard,
  SettingsRow,
  NeoxButton,
} from '../../../components/settings-base';

export const McpDetailView: React.FC = () => {
  const ctx = useSettingsContext();
  const { language } = useI18n();
  const zh = language === 'zh';

  const server = ctx.viewingMcpServer;
  if (!server) return null;

  const status: string = ctx.mcpConnectionStatus?.[server.id] || 'disconnected';
  const tools: any[] = ctx.mcpServerTools?.[server.id] ?? [];
  const lastError: string | undefined = ctx.mcpLastErrors?.[server.id];

  const handleBack = () => {
    ctx.setViewingMcpServer(null);
  };
  const handleEdit = () => {
    /* 切回编辑模式: 走 handleMcpEdit 它会 setEditingMcpServer + 填表 */
    ctx.handleMcpEdit(server);
    ctx.setViewingMcpServer(null);
  };
  const handleDelete = () => {
    ctx.handleMcpDelete(server);
    ctx.setViewingMcpServer(null);
  };
  const handleConnect = () => ctx.handleMcpConnect(server.id);
  const handleDisconnect = () => ctx.handleMcpDisconnect(server.id);

  const statusLabel = (() => {
    switch (status) {
      case 'connected': return zh ? '已连接' : 'Connected';
      case 'connecting': return zh ? '连接中...' : 'Connecting...';
      case 'error': return zh ? '连接失败' : 'Failed';
      default: return zh ? '未连接' : 'Disconnected';
    }
  })();
  const statusColor = (() => {
    switch (status) {
      case 'connected': return '#16a34a';
      case 'connecting': return '#d97706';
      case 'error': return '#dc2626';
      default: return 'var(--neox-fg-hint)';
    }
  })();

  return (
    <div className="settings-panel-content">
      {/* 头部: title + back */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <PageTitle
          title={server.name || server.id}
          subtitle={zh
            ? `MCP 服务器详情 · ${server.scope === 'workspace' ? '工作区级' : '用户级'}`
            : `MCP server detail · ${server.scope}`}
        />
        <NeoxButton
          variant="ghost"
          size="sm"
          onClick={handleBack}
          leading={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          }
        >
          {zh ? '返回' : 'Back'}
        </NeoxButton>
      </div>

      {/* 状态卡片 */}
      <Section>
        <SectionTitle title={zh ? '状态' : 'Status'} />
        <SettingsCard>
          <SettingsRow
            title={zh ? '连接状态' : 'Connection'}
            control={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, color: statusColor }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
                {statusLabel}
              </span>
            }
          />
          {status === 'connected' && (
            <SettingsRow
              title={zh ? '工具数量' : 'Tool Count'}
              control={<span style={{ fontWeight: 600, color: '#16a34a' }}>{tools.length}</span>}
            />
          )}
          {status === 'error' && lastError && (
            <SettingsRow
              title={zh ? '错误信息' : 'Error'}
              desc={lastError}
              control={null}
            />
          )}
        </SettingsCard>
      </Section>

      {/* 配置卡片 */}
      <Section>
        <SectionTitle title={zh ? '配置' : 'Configuration'} />
        <SettingsCard>
          <SettingsRow
            title={zh ? '服务器 ID' : 'Server ID'}
            control={<code style={{ fontFamily: 'var(--neox-font-mono, monospace)', fontSize: 12 }}>{server.id}</code>}
          />
          <SettingsRow
            title={zh ? '传输协议' : 'Transport'}
            control={<code style={{ fontFamily: 'var(--neox-font-mono, monospace)', fontSize: 11, textTransform: 'uppercase', padding: '2px 7px', background: 'color-mix(in srgb, var(--neox-fg-primary) 8%, transparent)', borderRadius: 5, fontWeight: 600 }}>{server.transport}</code>}
          />
          <SettingsRow
            title={zh ? '配置范围' : 'Scope'}
            control={<span>{server.scope === 'workspace' ? (zh ? '工作区' : 'Workspace') : (zh ? '用户级' : 'User')}</span>}
          />
          {server.transport === 'stdio' && server.command && (
            <SettingsRow
              title={zh ? '命令' : 'Command'}
              control={<code style={{ fontFamily: 'var(--neox-font-mono, monospace)', fontSize: 12, color: 'var(--neox-fg-secondary)' }}>{server.command}</code>}
            />
          )}
          {server.transport === 'stdio' && server.args && server.args.length > 0 && (
            <SettingsRow
              title={zh ? '参数' : 'Arguments'}
              control={
                <code style={{ fontFamily: 'var(--neox-font-mono, monospace)', fontSize: 11.5, color: 'var(--neox-fg-secondary)', maxWidth: 480, display: 'inline-block', textAlign: 'right', wordBreak: 'break-all' }}>
                  {Array.isArray(server.args) ? server.args.join(' ') : server.args}
                </code>
              }
            />
          )}
          {server.transport !== 'stdio' && server.url && (
            <SettingsRow
              title="URL"
              control={<code style={{ fontFamily: 'var(--neox-font-mono, monospace)', fontSize: 12, color: 'var(--neox-fg-secondary)' }}>{server.url}</code>}
            />
          )}
          {server.env && Object.keys(server.env).length > 0 && (
            <SettingsRow
              title={zh ? '环境变量' : 'Environment'}
              control={
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, fontFamily: 'var(--neox-font-mono, monospace)', fontSize: 11.5, color: 'var(--neox-fg-secondary)' }}>
                  {Object.entries(server.env).map(([k, v]) => (
                    <span key={k}>{k}=<span style={{ opacity: 0.6 }}>{String(v).length > 20 ? String(v).slice(0, 20) + '...' : String(v)}</span></span>
                  ))}
                </div>
              }
            />
          )}
          <SettingsRow
            title={zh ? '自动连接' : 'Auto Connect'}
            control={<span>{server.autoConnect ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')}</span>}
          />
        </SettingsCard>
      </Section>

      {/* 工具列表 — 完整 description, 不截断, 包含 input schema */}
      {status === 'connected' && tools.length > 0 && (
        <Section>
          <SectionTitle
            title={zh ? `工具列表 (${tools.length})` : `Tools (${tools.length})`}
          />
          <div className="mcp-detail-tools">
            {tools.map((tool: any, i: number) => {
              const name = tool?.name ?? `tool-${i}`;
              const desc = tool?.description ?? '';
              const schema = tool?.inputSchema;
              const props = schema?.properties ? Object.keys(schema.properties) : [];
              const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
              return (
                <div key={name} className="mcp-detail-tool">
                  <div className="mcp-detail-tool__header">
                    <code className="mcp-detail-tool__name">{name}</code>
                    {tool?.annotations?.readOnlyHint && (
                      <span className="mcp-detail-tool__hint mcp-detail-tool__hint--read">read</span>
                    )}
                    {tool?.annotations?.destructiveHint && (
                      <span className="mcp-detail-tool__hint mcp-detail-tool__hint--destructive">destructive</span>
                    )}
                  </div>
                  {desc && <p className="mcp-detail-tool__desc">{desc}</p>}
                  {props.length > 0 && (
                    <div className="mcp-detail-tool__params">
                      {props.map((p) => (
                        <code key={p} className={`mcp-detail-tool__param ${required.includes(p) ? 'required' : ''}`}>
                          {p}{required.includes(p) ? ' *' : ''}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* 操作按钮 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 24, paddingBottom: 12 }}>
        <NeoxButton variant="danger" onClick={handleDelete} leading={<Icons.Delete width={14} height={14} />}>
          {zh ? '删除' : 'Delete'}
        </NeoxButton>
        <div style={{ display: 'flex', gap: 10 }}>
          {status === 'connected' ? (
            <NeoxButton variant="secondary" onClick={handleDisconnect}>
              {zh ? '断开连接' : 'Disconnect'}
            </NeoxButton>
          ) : (
            <NeoxButton variant="secondary" onClick={handleConnect} disabled={status === 'connecting'}>
              {status === 'connecting' ? (zh ? '连接中...' : 'Connecting...') : (zh ? '连接' : 'Connect')}
            </NeoxButton>
          )}
          <NeoxButton variant="primary" onClick={handleEdit} leading={<Icons.Edit />}>
            {zh ? '编辑' : 'Edit'}
          </NeoxButton>
        </div>
      </div>
    </div>
  );
};

export default McpDetailView;
