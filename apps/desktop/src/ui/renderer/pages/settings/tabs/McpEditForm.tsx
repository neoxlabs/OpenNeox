import React from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import {
  PageTitle,
  Segmented,
  Switch,
  NeoxInput,
  NeoxTextarea,
  NeoxButton,
} from '../../../components/settings-base';
import { inferRemoteTransport } from './mcpRemoteTransport';

export const McpEditForm: React.FC = () => {
  const ctx = useSettingsContext();
  const { language } = useI18n();
  const zh = language === 'zh';
  const t = ctx.t;

  const mode: 'add' | 'edit' = ctx.editingMcpServer ? 'edit' : 'add';

  const handleBack = () => {
    ctx.setShowMcpAddForm(false);
    ctx.setEditingMcpServer(null);
    ctx.resetMcpForm();
  };

  /* 粘贴 JSON 一键填表 */
  const handlePasteJson = (text: string): boolean => {
    try {
      const parsed = JSON.parse(text);
      let id: string | undefined;
      let cfg: any;
      if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
        const keys = Object.keys(parsed.mcpServers);
        if (keys.length === 0) return false;
        id = keys[0];
        cfg = parsed.mcpServers[id!];
      } else if (parsed?.command || parsed?.url) {
        cfg = parsed;
      } else {
        return false;
      }
      /* 远程协议按源配置的 type 定 (同 core 的 inferRemoteMcpTransport): Claude Code 的
       * type:"http" 是 Streamable HTTP, 当成 SSE 去连必然失败 */
      const transport = cfg.url ? inferRemoteTransport(cfg.type ?? cfg.transport, String(cfg.url)) : 'stdio';
      if (id) ctx.setMcpFormId(id);
      if (cfg.name) ctx.setMcpFormName(cfg.name);
      else if (id) ctx.setMcpFormName(id.charAt(0).toUpperCase() + id.slice(1));
      ctx.setMcpFormTransport(transport);
      if (transport === 'stdio') {
        ctx.setMcpFormCommand(cfg.command || '');
        ctx.setMcpFormArgs(Array.isArray(cfg.args) ? cfg.args.join(' ') : (cfg.args || ''));
      } else {
        ctx.setMcpFormUrl(cfg.url || '');
      }
      if (cfg.env && typeof cfg.env === 'object') {
        const envStr = Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`).join('\n');
        ctx.setMcpFormEnv(envStr);
      }
      return true;
    } catch {
      return false;
    }
  };

  return (
    <div className="settings-panel-content">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <PageTitle
          title={mode === 'edit' ? (zh ? '编辑 MCP 服务器' : 'Edit MCP Server') : (zh ? '添加 MCP 服务器' : 'Add MCP Server')}
          subtitle={mode === 'edit'
            ? (zh ? '修改 MCP 服务器连接参数' : 'Update MCP server connection params')
            : (zh ? '配置一个 MCP 服务器, 给 Agent 提供工具' : 'Configure an MCP server to give the agent tools')}
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

      <div className="nx-form">
        {/* 粘贴 JSON 一键填表 — 添加模式时显示 */}
        {mode === 'add' && (
          <label className="nx-field">
            <span className="nx-field__label">{zh ? '粘贴配置 (推荐)' : 'Paste config (recommended)'}</span>
            <span className="nx-field__hint">
              {zh ? 'MCP 文档里给的 JSON 直接粘进来, 下面的字段会自动填好' : 'Paste the JSON from the MCP docs — the fields below fill in automatically'}
            </span>
            <NeoxTextarea
              placeholder={`{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]\n    }\n  }\n}`}
              rows={6}
              style={{ fontFamily: 'var(--neox-font-mono, "SF Mono", Menlo, monospace)', fontSize: 12 }}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (handlePasteJson(text)) {
                  e.preventDefault();
                  (e.currentTarget as HTMLTextAreaElement).value = '';
                }
              }}
            />
          </label>
        )}

        <label className="nx-field">
          <span className="nx-field__label">{zh ? '服务器 ID' : 'Server ID'} <em>*</em></span>
          <span className="nx-field__hint">{zh ? '唯一标识, 一般跟 npm 包名后半段一致' : 'Unique id, usually the npm package suffix'}</span>
          <NeoxInput
            value={ctx.mcpFormId}
            onChange={(e) => ctx.setMcpFormId(e.target.value)}
            placeholder="filesystem"
            disabled={!!ctx.editingMcpServer}
          />
        </label>

        <label className="nx-field">
          <span className="nx-field__label">{zh ? '显示名称' : 'Display name'}</span>
          <NeoxInput
            value={ctx.mcpFormName}
            onChange={(e) => ctx.setMcpFormName(e.target.value)}
            placeholder="Filesystem"
          />
        </label>

        <div className="nx-field">
          <span className="nx-field__label">{zh ? '连接方式' : 'Transport'}</span>
          <Segmented
            aria-label={zh ? '连接方式' : 'Transport'}
            value={ctx.mcpFormTransport}
            onChange={(v) => ctx.setMcpFormTransport(v as any)}
            options={[
              { value: 'stdio', label: zh ? '本地命令 (STDIO)' : 'Local command (STDIO)' },
              { value: 'http', label: zh ? '远程地址 (HTTP)' : 'Remote URL (HTTP)' },
              { value: 'sse', label: zh ? '远程地址 (旧版 SSE)' : 'Remote URL (legacy SSE)' },
            ]}
          />
        </div>

        {ctx.mcpFormTransport === 'stdio' ? (
          <>
            <label className="nx-field">
              <span className="nx-field__label">{zh ? '命令' : 'Command'} <em>*</em></span>
              <span className="nx-field__hint">{zh ? '例如 npx / uvx / python' : 'e.g. npx / uvx / python'}</span>
              <NeoxInput
                value={ctx.mcpFormCommand}
                onChange={(e) => ctx.setMcpFormCommand(e.target.value)}
                placeholder="npx"
              />
            </label>
            <label className="nx-field">
              <span className="nx-field__label">{zh ? '参数' : 'Arguments'}</span>
              <span className="nx-field__hint">{zh ? '用空格分开' : 'Space separated'}</span>
              <NeoxInput
                value={ctx.mcpFormArgs}
                onChange={(e) => ctx.setMcpFormArgs(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-filesystem /path"
              />
            </label>
          </>
        ) : (
          <label className="nx-field">
            <span className="nx-field__label">URL <em>*</em></span>
            <NeoxInput
              value={ctx.mcpFormUrl}
              onChange={(e) => ctx.setMcpFormUrl(e.target.value)}
              placeholder={ctx.mcpFormTransport === 'sse' ? 'http://localhost:3000/sse' : 'https://example.com/mcp'}
            />
          </label>
        )}

        <label className="nx-field">
          <span className="nx-field__label">{zh ? '环境变量' : 'Environment variables'}</span>
          <span className="nx-field__hint">{zh ? '每行一个 KEY=VALUE, 用来放 API token 之类 (可选)' : 'One KEY=VALUE per line, e.g. API tokens (optional)'}</span>
          <NeoxTextarea
            value={ctx.mcpFormEnv}
            onChange={(e) => ctx.setMcpFormEnv(e.target.value)}
            placeholder={'GITHUB_TOKEN=ghp_xxx\nDEBUG=1'}
            rows={3}
            style={{ fontFamily: 'var(--neox-font-mono, "SF Mono", Menlo, monospace)', fontSize: 12 }}
          />
        </label>

        <div className="nx-field">
          <span className="nx-field__label">{zh ? '在哪里可用' : 'Available in'}</span>
          <Segmented
            aria-label={zh ? '在哪里可用' : 'Available in'}
            value={ctx.mcpFormScope}
            onChange={(v) => ctx.setMcpFormScope(v as any)}
            options={[
              { value: 'user', label: zh ? '所有项目' : 'All projects' },
              { value: 'workspace', label: zh ? '仅当前项目' : 'This project only' },
            ]}
          />
        </div>

        <div className="nx-field nx-field--inline">
          <div className="nx-field__text">
            <span className="nx-field__label">{zh ? '启动时自动连接' : 'Connect on launch'}</span>
            <span className="nx-field__hint">{zh ? '关掉的话, 要用时在列表里手动点连接' : 'If off, connect it manually from the list'}</span>
          </div>
          <Switch
            checked={ctx.mcpFormAutoConnect}
            onChange={(v) => ctx.setMcpFormAutoConnect(v)}
            aria-label={zh ? '启动时自动连接' : 'Connect on launch'}
          />
        </div>
      </div>

      <div className="nx-form__actions">
        <NeoxButton variant="secondary" onClick={handleBack}>
          {t?.common?.cancel ?? (zh ? '取消' : 'Cancel')}
        </NeoxButton>
        <NeoxButton
          variant="primary"
          onClick={ctx.handleMcpSave}
          disabled={
            !ctx.mcpFormId?.trim() ||
            (ctx.mcpFormTransport === 'stdio' ? !ctx.mcpFormCommand?.trim() : !ctx.mcpFormUrl?.trim())
          }
        >
          {t?.common?.save ?? (zh ? '保存' : 'Save')}
        </NeoxButton>
      </div>
    </div>
  );
};

export default McpEditForm;
