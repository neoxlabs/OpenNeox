import React from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../hooks/useI18n';
import { NeoxIllus } from '../../media/illus';
import { ChoiceDialog } from './ChoiceDialog';
import { useCloudAgentAvailable } from '../shell/editionHooks';
import { isNeoxCloudProviderId } from '../../../shared/neoxCloud';

export const RunDestDialog: React.FC<{
  selectedProviderId?: string | null;
  onClose: () => void;
}> = ({ selectedProviderId, onClose }) => {
  const { isZh } = useI18n();
  const cloudNotOpen = !useCloudAgentAvailable();
  const cloudBlocked = cloudNotOpen || (!!selectedProviderId && !isNeoxCloudProviderId(selectedProviderId));
  const [cloudActive, setCloudActive] = React.useState(false);

  React.useEffect(() => {
    const handler = (ev: Event) => setCloudActive(!!(ev as CustomEvent).detail?.cloudActive);
    window.addEventListener('neox:active-session-cloud-state', handler as EventListener);
    window.dispatchEvent(new CustomEvent('neox:request-cloud-state'));
    return () => window.removeEventListener('neox:active-session-cloud-state', handler as EventListener);
  }, []);

  return (
    <ChoiceDialog<'local' | 'cloud'>
      title={isZh ? '运行位置' : 'Run target'}
      sub={isZh ? '这个会话的 Agent 在哪台机器上干活。' : 'Which machine this conversation’s agent works on.'}
      options={[
        {
          id: 'local',
          art: NeoxIllus.runLocal,
          name: isZh ? '本地' : 'Local',
          lead: isZh ? '在你这台电脑上跑' : 'Runs on this computer',
          points: isZh
            ? ['直接读写本机文件和项目', '用你自己的命令行和浏览器', '关掉电脑任务就停']
            : ['Works on local files and projects directly', 'Uses your own shell and browser', 'Stops when the computer sleeps'],
          /* 已经推到云端的会话不能拉回本地 (原面板同样只是关掉) */
          disabled: cloudActive,
          disabledNote: isZh ? '已在云端' : 'Already in cloud',
        },
        {
          id: 'cloud',
          art: NeoxIllus.runCloud,
          name: isZh ? '云端' : 'Cloud',
          lead: isZh ? '推到云上接着跑' : 'Continues in the cloud',
          points: isZh
            ? ['关机、合盖也不停', '手机上随时看进度', '需要 Neox Cloud 模型']
            : ['Keeps going when you shut the lid', 'Follow along from your phone', 'Needs a Neox Cloud model'],
          disabled: cloudBlocked && !cloudActive,
          disabledNote: cloudNotOpen
            ? (isZh ? '暂未开放' : 'Not available yet')
            : (isZh ? '需云端模型' : 'Cloud model required'),
        },
      ]}
      current={cloudActive ? 'cloud' : 'local'}
      onPick={(id) => {
        if (id === 'cloud') window.dispatchEvent(new CustomEvent('neox:request-push-current-to-cloud'));
        onClose();
      }}
      onClose={onClose}
      foot={cloudNotOpen
        ? (isZh ? '云端运行还没开放, 现在所有任务都在你自己的机器上跑。' : 'Cloud runs are not available yet — everything runs on your own machine.')
        : undefined}
    />
  );
};

type McpRow = { id: string; name?: string; transport?: string; enabled?: boolean; scope?: string };

export const McpDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { isZh } = useI18n();
  const api = (window as any).neox;
  const [servers, setServers] = React.useState<McpRow[] | null>(null);
  const [tools, setTools] = React.useState<Record<string, number>>({});
  const [globalOn, setGlobalOn] = React.useState(true);
  const [q, setQ] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const [list, on] = await Promise.all([
      api?.mcpList?.().catch(() => []) ?? [],
      api?.mcpGetEnabled?.().catch(() => true) ?? true,
    ]);
    setServers(list ?? []);
    setGlobalOn(!!on);
    const counts: Record<string, number> = {};
    await Promise.all((list ?? []).map(async (s: McpRow) => {
      try {
        /* mcpGetTools 回的是包装对象 {success, tools} —— 三种返回形都认, 同设置页 */
        const res: any = await api?.mcpGetTools?.(s.id);
        const t = Array.isArray(res) ? res : (res?.tools ?? []);
        counts[s.id] = Array.isArray(t) ? t.length : 0;
      } catch { counts[s.id] = 0; }
    }));
    setTools(counts);
  }, [api]);

  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try { await fn(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  const openSettings = () => {
    try { localStorage.setItem('neox-settings-initial-tab', 'mcp'); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab: 'mcp' } }));
    onClose();
  };

  const query = q.trim().toLowerCase();
  const shown = (servers ?? []).filter((s) => !query
    || (s.name || s.id).toLowerCase().includes(query)
    || (s.transport || '').toLowerCase().includes(query));
  const onCount = (servers ?? []).filter((s) => s.enabled !== false).length;

  return createPortal(
    <div className="nx-choice" role="presentation">
      <div className="nx-choice__scrim" onMouseDown={onClose} aria-hidden="true" />
      <div className="nx-choice__card nx-mcpdlg" role="dialog" aria-modal="true" aria-label="MCP">
        <button type="button" className="nx-choice__close" onClick={onClose} aria-label={isZh ? '关闭' : 'Close'}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <div className="nx-mcpdlg__head">
          <span className="nx-mcpdlg__art" aria-hidden="true">
            <span className="nx-choice__glow" />
            <img src={NeoxIllus.mcp} alt="" draggable={false} />
          </span>
          <span className="nx-mcpdlg__intro">
            <h3 className="nx-choice__title">MCP</h3>
            <p className="nx-choice__sub">
              {isZh
                ? '外部工具服务器: 接上以后, Agent 就能用它们提供的工具 (比如查数据库、读设计稿)。'
                : 'External tool servers — once connected, the agent can use the tools they provide (databases, design files…).'}
            </p>
          </span>
          <label className="nx-mcpdlg__global">
            <span>{globalOn ? (isZh ? '已启用' : 'On') : (isZh ? '已停用' : 'Off')}</span>
            <input
              type="checkbox"
              role="switch"
              checked={globalOn}
              disabled={busy !== null}
              onChange={(e) => void run('global', () => api.mcpSetEnabled(e.target.checked))}
            />
            <i aria-hidden="true" />
          </label>
        </div>

        {servers && servers.length > 4 ? (
          <input
            className="nx-mcpdlg__search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isZh ? '搜索服务…' : 'Search servers…'}
          />
        ) : null}

        <div className={`nx-mcpdlg__list${globalOn ? '' : ' is-off'}`}>
          {servers === null ? (
            <div className="nx-mcpdlg__empty neox-text-shimmer">{isZh ? '读取中…' : 'Loading…'}</div>
          ) : servers.length === 0 ? (
            <div className="nx-mcpdlg__empty">
              {isZh ? '还没有接任何 MCP 服务。' : 'No MCP servers yet.'}
            </div>
          ) : shown.length === 0 ? (
            <div className="nx-mcpdlg__empty">{isZh ? '没有匹配的服务' : 'No matching servers'}</div>
          ) : shown.map((s) => {
            const on = s.enabled !== false;
            return (
              <div key={`${s.scope ?? ''}:${s.id}`} className={`nx-mcpdlg__row${on ? '' : ' is-off'}`}>
                <span className="nx-mcpdlg__dot" data-on={on ? '1' : '0'} aria-hidden="true" />
                <span className="nx-mcpdlg__name">{s.name || s.id}</span>
                <span className="nx-mcpdlg__meta">
                  {(s.transport || '—')} · {isZh ? `${tools[s.id] ?? 0} 个工具` : `${tools[s.id] ?? 0} tools`}
                </span>
                <label className="nx-mcpdlg__switch" title={on ? (isZh ? '停用' : 'Disable') : (isZh ? '启用' : 'Enable')}>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={on}
                    disabled={busy !== null || !s.scope}
                    onChange={(e) => void run(s.id, () => api.mcpUpdate(s.scope, s.id, { enabled: e.target.checked }))}
                    aria-label={s.name || s.id}
                  />
                  <i aria-hidden="true" />
                </label>
              </div>
            );
          })}
        </div>

        <div className="nx-mcpdlg__foot">
          <span className={`nx-choice__foot${err ? ' is-error' : ''}`}>
            {err
              ? (isZh ? `没改成: ${err}` : `Couldn't change: ${err}`)
              : servers && servers.length > 0
                ? (isZh ? `${onCount}/${servers.length} 个启用` : `${onCount} of ${servers.length} on`)
                : null}
          </span>
          <button type="button" className="nx-mcpdlg__manage" onClick={openSettings}>
            {servers && servers.length === 0 ? (isZh ? '去添加' : 'Add one') : (isZh ? '管理' : 'Manage')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
