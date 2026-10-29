import React from 'react';
import { copyToClipboard } from '../../../utils/copyToClipboard';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import { getContextSnapshot } from '../../../state/contextSnapshot';
import { confirmAsync } from '../../../components/confirmEvents';
import { dispatchOpFailedFromError } from '../../../components/notifyEvents';
import { PageTitle, NeoxButton, Segmented, Section, SectionTitle, SettingsCard, SettingsRow, SwitchRow, RowIcon } from '../../../components/settings-base';
import { setContextProfile, useContextProfile } from '../../../modules/agent-timeline/ContextModeSection';
import { NeoxIllus } from '../../../media/illus';

// ==================== JSON 树节点（递归） ====================
const ContextJsonNode: React.FC<{
  data: any; label: string; depth: number; defaultOpen?: boolean;
}> = ({ data, label, depth, defaultOpen = false }) => {
  const [open, setOpen] = React.useState(defaultOpen || depth < 1);
  const indent = depth * 16;
  /* 折叠行是纯 div — 补键盘可达: Enter/Space 等效点击 */
  const toggleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(o => !o);
    }
  };

  if (data === null || data === undefined) {
    return (
      <div className="ctx-json-line" style={{ paddingLeft: indent }}>
        <span className="ctx-json-key">{label}</span>
        <span className="ctx-json-null">null</span>
      </div>
    );
  }
  if (typeof data === 'number') {
    return (
      <div className="ctx-json-line" style={{ paddingLeft: indent }}>
        <span className="ctx-json-key">{label}</span>
        <span className="ctx-json-number">{data >= 1000 ? data.toLocaleString() : String(data)}</span>
      </div>
    );
  }
  if (typeof data === 'string') {
    return (
      <div className="ctx-json-line" style={{ paddingLeft: indent }}>
        <span className="ctx-json-key">{label}</span>
        <span className="ctx-json-string">"{data}"</span>
      </div>
    );
  }
  if (typeof data === 'boolean') {
    return (
      <div className="ctx-json-line" style={{ paddingLeft: indent }}>
        <span className="ctx-json-key">{label}</span>
        <span className="ctx-json-bool">{String(data)}</span>
      </div>
    );
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return (
        <div className="ctx-json-line" style={{ paddingLeft: indent }}>
          <span className="ctx-json-key">{label}</span>
          <span className="ctx-json-bracket">[]</span>
        </div>
      );
    }
    return (
      <div>
        <div className="ctx-json-line ctx-json-toggle" style={{ paddingLeft: indent }} onClick={() => setOpen(!open)} role="button" tabIndex={0} onKeyDown={toggleKeyDown}>
          <span className={`ctx-json-arrow ${open ? 'open' : ''}`}>&#9654;</span>
          <span className="ctx-json-key">{label}</span>
          <span className="ctx-json-bracket">[{!open && <span className="ctx-json-preview">{data.length} items</span>}]</span>
        </div>
        {open && data.map((item: any, i: number) => (
          <ContextJsonNode key={i} data={item} label={String(i)} depth={depth + 1} />
        ))}
      </div>
    );
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return (
        <div className="ctx-json-line" style={{ paddingLeft: indent }}>
          <span className="ctx-json-key">{label}</span>
          <span className="ctx-json-bracket">{'{}'}</span>
        </div>
      );
    }
    return (
      <div>
        <div className="ctx-json-line ctx-json-toggle" style={{ paddingLeft: indent }} onClick={() => setOpen(!open)} role="button" tabIndex={0} onKeyDown={toggleKeyDown}>
          <span className={`ctx-json-arrow ${open ? 'open' : ''}`}>&#9654;</span>
          <span className="ctx-json-key">{label}</span>
          <span className="ctx-json-bracket">{'{'}{!open && <span className="ctx-json-preview">{entries.length} keys</span>}{'}'}</span>
        </div>
        {open && entries.map(([k, v]) => (
          <ContextJsonNode key={k} data={v} label={k} depth={depth + 1} />
        ))}
      </div>
    );
  }
  return null;
};

// ==================== 上下文数据查看器（显示实际会话内容） ====================
const ContextDataViewer: React.FC<{
  language: string;
}> = ({ language: lang }) => {
  const snap = getContextSnapshot();
  const [sessionData, setSessionData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const sid = snap?.sessionId;
    if (!sid) { setLoading(false); return; }
    setLoading(true);
    /* peekSession = 只读 (getSession 会把主进程的当前会话切成这个 id) */
    Promise.resolve((window.neox as any).peekSession?.(sid) ?? null)
      .then((session: any) => {
        if (!session) { setSessionData(null); return; }
        // 构建用户能看懂的上下文结构
        setSessionData({
          sessionId: session.id,
          model: session.modelId,
          createdAt: new Date(session.createdAt).toLocaleString(),
          totalTokens: session.totalTokens,
          contextUsed: session.contextUsed,
          contextWindow: session.contextWindow,
          messageCount: session.messages?.length || 0,
          messages: (session.messages || []).map((msg: any) => ({
            role: msg.role,
            tokens: msg.tokens || 0,
            timestamp: msg.timestamp ? new Date(msg.timestamp).toLocaleString() : null,
            text: msg.text?.length > 500 ? msg.text.slice(0, 500) + '...' : msg.text,
          })),
        });
      })
      .catch(() => setSessionData(null))
      .finally(() => setLoading(false));
  }, [snap?.sessionId]);

  if (loading) {
    return <div className="neox-text-shimmer" style={{ padding: '12px 0', fontSize: 11, color: 'var(--text-muted)' }}>{lang === 'zh' ? '加载中...' : 'Loading...'}</div>;
  }
  if (!sessionData) {
    /* 两种情况分开说: 没有打开的会话 / 打开的是还没发过消息的新会话 (库里还没有这条) */
    return (
      <div style={{ padding: '12px 0', fontSize: 12, color: 'var(--text-muted)' }}>
        {!snap?.sessionId
          ? (lang === 'zh' ? '没有打开的会话。' : 'No conversation is open.')
          : (lang === 'zh' ? '当前会话还没有消息。' : 'This conversation has no messages yet.')}
      </div>
    );
  }

  return (
    <div className="ctx-json-viewer">
      <div className="ctx-json-toolbar">
        <NeoxButton variant="ghost" size="sm" onClick={() => void copyToClipboard(JSON.stringify(sessionData, null, 2))}>
          {lang === 'zh' ? '复制 JSON' : 'Copy JSON'}
        </NeoxButton>
        <NeoxButton
          variant="ghost"
          size="sm"
          onClick={async () => {
            if (!snap?.sessionId) return;
            try { await window.neox.exportSession(snap.sessionId, 'json'); }
            catch (e) { dispatchOpFailedFromError(lang === 'zh' ? '导出会话' : 'Export session', e); }
          }}
          disabled={!snap?.sessionId}
        >
          {lang === 'zh' ? '导出完整会话' : 'Export full session'}
        </NeoxButton>
      </div>
      <div className="ctx-json-tree">
        <ContextJsonNode data={sessionData} label="session" depth={0} defaultOpen />
      </div>
    </div>
  );
};

// ==================== ContextTab ====================

const ContextTab: React.FC = () => {
  const { language } = useI18n();
  const {
    contextUsage,
    contextConfig,
    contextLoading,
    loadContextConfig,
    handleContextConfigChange,
    buildByRole,
  } = useSettingsContext();
  const contextProfile = useContextProfile();
  const [rawOpen, setRawOpen] = React.useState(false);

  const formatK = (n: number): string => {
    if (n >= 1_000_000) {
      const value = n / 1_000_000;
      const nearest = Math.round(value);
      if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
      const formatted = value >= 10 ? `${Math.round(value)}` : value.toFixed(1).replace(/\.0$/, '');
      return `${formatted}M`;
    }
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return n.toString();
  };

  // 直接从 snapshot 读，不等 async loadContextConfig — 和弹窗一样同步取值
  const snap = getContextSnapshot();
  const currentTokens = contextUsage?.currentTokens || snap?.tokensUsed || 0;
  const maxTokens = (snap?.contextWindow && snap.contextWindow > 0 ? snap.contextWindow : null)
    || contextUsage?.maxTokens
    || 128000;
  const usagePercent = contextUsage?.usagePercent
    || (maxTokens > 0 ? Math.round((currentTokens / maxTokens) * 100) : 0);
  const remaining = maxTokens - currentTokens;
  const compactionLimit = Math.floor(maxTokens * (contextConfig.thresholdPercent / 100));
  const tokensUntilCompaction = Math.max(0, compactionLimit - currentTokens);
  const autoCompactionEnabled = contextConfig.thresholdPercent < 100;

  // Build role proportions for stacked bar
  const roleColors: Record<string, string> = { system: '#8a93a6', user: '#41a0ff', assistant: '#9ccdff', tool: '#f2a33a' };
  const roleLabels: Record<string, string> = {
    system: language === 'zh' ? '系统提示' : 'System',
    user: language === 'zh' ? '你的消息' : 'You',
    assistant: language === 'zh' ? '模型回复' : 'Replies',
    tool: language === 'zh' ? '工具' : 'Tools',
  };
  const roles = ['system', 'user', 'assistant', 'tool'];
  // byRole: 优先 contextUsage，兜底从 snapshot.breakdown 构建
  const effectiveByRole = (contextUsage?.byRole && Object.keys(contextUsage.byRole).length > 0)
    ? contextUsage.byRole as Record<string, { count: number; tokens: number }>
    : buildByRole(snap?.breakdown || {});
  const rolePcts = roles.map(r => {
    const data = effectiveByRole?.[r];
    return {
      role: r,
      tokens: data?.tokens || 0,
      count: typeof data?.count === 'number' ? data.count : undefined,
      pct: currentTokens > 0 ? ((data?.tokens || 0) / currentTokens * 100) : 0,
    };
  });

  const zh = language === 'zh';

  /* 每类占用下面的子项 (写在行说明里) */
  const details = ((contextUsage as any)?.breakdown || snap?.breakdown)?.details || {};
  const subItemsOf = (role: string): Array<{ label: string; tokens: number }> =>
    role === 'system' ? [
      { label: zh ? '系统提示词' : 'System prompt', tokens: details.systemPromptTokens || 0 },
      { label: zh ? '隐藏指令' : 'Hidden instructions', tokens: details.hiddenInstructionsTokens || 0 },
      { label: zh ? 'Agent 前缀' : 'Agent prefix', tokens: details.agentPrefixTokens || 0 },
    ] : role === 'user' ? [
      { label: zh ? '文字' : 'Text', tokens: details.userTextTokens || 0 },
      { label: zh ? '附件' : 'Attachments', tokens: details.attachmentTextTokens || 0 },
      { label: zh ? '图片描述' : 'Image descriptions', tokens: details.imageDescriptionTokens || 0 },
    ] : role === 'assistant' ? [
      { label: zh ? '回复文字' : 'Reply text', tokens: details.assistantTextTokens || 0 },
    ] : role === 'tool' ? [
      { label: zh ? '工具定义' : 'Definitions', tokens: details.toolDefinitionsTokens || 0 },
      { label: zh ? '调用' : 'Calls', tokens: details.toolCallTokens || 0 },
      { label: zh ? '结果' : 'Results', tokens: details.toolResultTokens || 0 },
    ] : [];

  const sessionCache = (contextUsage as any)?.sessionCache || snap?.sessionCache;
  const hitRate = Math.round(Math.max(0, Math.min(1, sessionCache?.hitRate || 0)) * 100);
  const latestReq = (() => {
    const req = (contextUsage as any)?.latestRequestUsage || snap?.latestRequestUsage;
    if (!req) return null;
    const cacheRead = req.cacheReadTokens || 0;
    const cacheWrite = req.cacheWriteTokens || 0;
    const baseInput = Math.max(0, req.billableInputTokens ?? ((req.inputTokens || 0) - cacheRead - cacheWrite));
    const parts = [
      { key: 'in', label: zh ? '未命中' : 'Uncached', tokens: baseInput, color: '#8a93a6' },
      { key: 'read', label: zh ? '读缓存' : 'Cache read', tokens: cacheRead, color: '#41a0ff' },
      { key: 'write', label: zh ? '写缓存' : 'Cache write', tokens: cacheWrite, color: '#9ccdff' },
      { key: 'out', label: zh ? '输出' : 'Output', tokens: req.outputTokens || 0, color: '#f2a33a' },
    ];
    const total = parts.reduce((a, p) => a + p.tokens, 0);
    return total > 0 ? { parts, total } : null;
  })();

  const doCompact = async () => {
    const sid = getContextSnapshot()?.sessionId || 'current';
    try {
      await window.neox.compactSession(sid);
      loadContextConfig();
    } catch (e) {
      /* 静默失败会让用户以为压缩成功 (审计 P1) — 必须有可见反馈 */
      console.error('Compact failed:', e);
      dispatchOpFailedFromError(zh ? '压缩上下文' : 'Compact context', e);
    }
  };
  const doClear = async () => {
    const sid = getContextSnapshot()?.sessionId;
    if (!sid) return;
    const confirmed = await confirmAsync({
      title: zh ? '清空对话' : 'Clear conversation',
      variant: 'danger',
      message: zh
        ? '模型会忘掉这段对话，磁盘上的消息记录也会删除 —— 屏幕上的内容要到下次启动才消失。不可撤销。'
        : 'The model forgets this conversation and the stored messages are deleted — what is on screen goes away at next launch. This cannot be undone.',
      confirmLabel: zh ? '清空' : 'Clear',
    });
    if (!confirmed) return;
    try {
      await window.neox.clearSession(sid);
      loadContextConfig();
    } catch (e) {
      console.error('Clear failed:', e);
      dispatchOpFailedFromError(zh ? '清空上下文' : 'Clear context', e);
    }
  };

  return (
    <div className="settings-panel-content ctx3">
      <div className="mp-titlebar">
        <PageTitle title={zh ? '上下文' : 'Context'} subtitle={zh ? '这一轮带给模型的内容有多少' : 'How much this turn gives the model'} />
        <NeoxButton className="ctx3-refresh" variant="ghost" size="sm" onClick={loadContextConfig} title={zh ? '刷新' : 'Refresh'} aria-label={zh ? '刷新' : 'Refresh'}>
          <Icons.Refresh />
        </NeoxButton>
      </div>

      {contextLoading ? (
        <div className="loading-state">
          <Icons.Loader />
          <span className="neox-text-shimmer">{zh ? '加载中…' : 'Loading…'}</span>
        </div>
      ) : (
        <>
        <div className="mfs">
          {/* ===== 用量: 条按构成分色, 一眼看出谁占得多; 竖线 = 自动压缩线 ===== */}
          <section className="mfs-hero ctx2-hero">
            <img className="mfs-hero__art" src={NeoxIllus.ctxHero} alt="" draggable={false} />
            <div className="ctx2-hero__body">
              <div className="ctx2-hero__nums">
                <span className="ctx2-hero__used">{formatK(currentTokens)}</span>
                <span className="ctx2-hero__max">/ {formatK(maxTokens)}</span>
                <span className={`ctx2-hero__pct${usagePercent > 85 ? ' is-warn' : ''}`}>{usagePercent}%</span>
              </div>
              <div className="ctx2-bar ctx3-bar">
                {currentTokens > 0 && rolePcts.map(({ role, tokens }) => tokens > 0 ? (
                  <i key={role} style={{ flexBasis: `${Math.min(100, tokens / maxTokens * 100)}%`, background: roleColors[role] }} title={`${roleLabels[role]} ${formatK(tokens)}`} />
                ) : null)}
                {autoCompactionEnabled && <b style={{ left: `${contextConfig.thresholdPercent}%` }} title={zh ? `自动压缩线 ${contextConfig.thresholdPercent}%` : `Auto-compact at ${contextConfig.thresholdPercent}%`} />}
              </div>
              <div className="ctx2-hero__meta">
                <span>{zh ? `剩余 ${formatK(remaining)}` : `${formatK(remaining)} left`}</span>
                <span>{zh ? `${contextUsage?.messageCount ?? 0} 条消息` : `${contextUsage?.messageCount ?? 0} messages`}</span>
                {contextUsage?.toolMessageCount ? <span>{zh ? `${contextUsage.toolMessageCount} 次工具` : `${contextUsage.toolMessageCount} tool calls`}</span> : null}
                {autoCompactionEnabled && (
                  <span>{zh ? `距自动压缩 ${formatK(tokensUntilCompaction)}` : `${formatK(tokensUntilCompaction)} to auto-compact`}</span>
                )}
              </div>
              <div className="ctx2-hero__actions">
                <NeoxButton size="sm" onClick={() => void doCompact()} disabled={currentTokens < 1000}>{zh ? '立即压缩' : 'Compact now'}</NeoxButton>
                <button type="button" className="ctx2-danger" onClick={() => void doClear()} disabled={currentTokens === 0}>{zh ? '清空对话' : 'Clear'}</button>
              </div>
            </div>
          </section>

          {contextUsage?.warnings && contextUsage.warnings.length > 0 && (
            <div className="ctx-warnings">
              {contextUsage.warnings.map((w: string, i: number) => (
                <div key={i} className="ctx-warn-line"><Icons.AlertCircle /><span>{w}</span></div>
              ))}
            </div>
          )}

        </div>

          {/* ===== 占用构成: 一类一行, 子项写在说明里, 不用再点开 ===== */}
          <Section>
            <SectionTitle title={zh ? '占用构成' : 'What’s in it'} />
            <SettingsCard>
              {rolePcts.map(({ role, tokens, count, pct }) => {
                const parts = subItemsOf(role).filter((s) => s.tokens > 0);
                return (
                  <SettingsRow
                    key={role}
                    leading={<span className="ctx3-swatch" style={{ background: roleColors[role] }} aria-hidden="true" />}
                    title={<>{roleLabels[role]}{count && count > 0 ? <span className="ctx3-count">{zh ? `${count} 条` : `${count}`}</span> : null}</>}
                    desc={parts.length > 0
                      ? parts.map((s) => `${s.label} ${formatK(s.tokens)}`).join(' · ')
                      : (tokens > 0 ? undefined : (zh ? '还没有' : 'None yet'))}
                    control={(
                      <span className="ctx3-amount">
                        <b>{formatK(tokens)}</b>
                        <em>{pct.toFixed(pct > 0 && pct < 1 ? 1 : 0)}%</em>
                        <span className="ctx3-mini"><i style={{ width: `${Math.min(100, pct)}%`, background: roleColors[role] }} /></span>
                      </span>
                    )}
                  />
                );
              })}
            </SettingsCard>
          </Section>

          {/* ===== 缓存: 本会话命中率 + 最近一次请求 ===== */}
          {(sessionCache?.requests || latestReq) ? (
            <Section>
              <SectionTitle title={zh ? '缓存' : 'Cache'} />
              <SettingsCard>
                {sessionCache?.requests ? (
                  <SettingsRow
                    leading={<RowIcon src={NeoxIllus.quota} />}
                    title={zh ? '本会话命中率' : 'Session hit rate'}
                    desc={zh
                      ? `${sessionCache.requests} 次请求 · 读缓存 ${formatK(sessionCache.cacheReadTokens || 0)} · 未命中 ${formatK(sessionCache.baseInputTokens || 0)} · 写缓存 ${formatK(sessionCache.cacheWriteTokens || 0)}`
                      : `${sessionCache.requests} requests · read ${formatK(sessionCache.cacheReadTokens || 0)} · uncached ${formatK(sessionCache.baseInputTokens || 0)} · written ${formatK(sessionCache.cacheWriteTokens || 0)}`}
                    control={(
                      <span className="ctx3-amount ctx3-amount--rate">
                        <b>{hitRate}%</b>
                        <span className="ctx3-mini"><i style={{ width: `${hitRate}%`, background: '#41a0ff' }} /></span>
                      </span>
                    )}
                  />
                ) : null}
                {latestReq ? (
                  <SettingsRow
                    leading={<RowIcon src={NeoxIllus.routing} />}
                    title={zh ? '最近一次请求' : 'Latest request'}
                    desc={latestReq.parts.map((p) => `${p.label} ${formatK(p.tokens)}`).join(' · ')}
                    control={(
                      <span className="ctx3-amount">
                        <b>{formatK(latestReq.total)}</b>
                        <span className="ctx3-mini ctx3-mini--stack">
                          {latestReq.parts.map((p) => p.tokens > 0 ? (
                            <i key={p.key} style={{ flexBasis: `${p.tokens / latestReq.total * 100}%`, background: p.color }} title={`${p.label} ${formatK(p.tokens)}`} />
                          ) : null)}
                        </span>
                      </span>
                    )}
                  />
                ) : null}
              </SettingsCard>
            </Section>
          ) : null}

          {/* ===== 设置 ===== */}
          <Section>
            <SectionTitle title={zh ? '设置' : 'Settings'} />
            <SettingsCard>
              <SettingsRow
                leading={<RowIcon src={NeoxIllus.quota} />}
                title={zh ? '请求模式' : 'Request mode'}
                desc={contextProfile === 'lean'
                  ? (zh ? '节约：每次请求开局约 3K token。' : 'Saver: ~3K tokens per request.')
                  : (zh ? '标准：每次请求开局约 17–26K token。' : 'Standard: ~17–26K tokens per request.')}
                control={(
                  <Segmented
                    value={contextProfile}
                    onChange={(p) => { void setContextProfile(p).catch((e) => dispatchOpFailedFromError(zh ? '切换请求模式' : 'Switch request mode', e)); }}
                    aria-label={zh ? '请求模式' : 'Request mode'}
                    options={[
                      { value: 'full', label: zh ? '标准' : 'Standard' },
                      { value: 'lean', label: zh ? '节约' : 'Saver' },
                    ]}
                  />
                )}
              />
              <SwitchRow
                leading={<RowIcon src={NeoxIllus.ctxCompact} />}
                title={zh ? '自动压缩' : 'Auto-compact'}
                desc={autoCompactionEnabled
                  ? (zh ? `占用到 ${contextConfig.thresholdPercent}% 时自动压缩。` : `Compacts at ${contextConfig.thresholdPercent}% usage.`)
                  : (zh ? '已关闭，满了需要手动压缩。' : 'Off. Compact manually when full.')}
                checked={autoCompactionEnabled}
                onChange={(on) => handleContextConfigChange('thresholdPercent', on ? 85 : 100)}
              />
              {autoCompactionEnabled && (
                <SettingsRow
                  leading={<RowIcon src={NeoxIllus.ctxTank} />}
                  title={zh ? '触发线' : 'Threshold'}
                  desc={zh ? '占用到这条线就压缩，页头条上的竖线就是它。' : 'Compacts at this line — the tick on the bar above.'}
                  control={(
                    <Segmented
                      value={String(contextConfig.thresholdPercent)}
                      onChange={(v) => handleContextConfigChange('thresholdPercent', Number(v))}
                      aria-label={zh ? '触发阈值' : 'Threshold'}
                      options={[70, 80, 85, 90].map((t) => ({ value: String(t), label: `${t}%` }))}
                    />
                  )}
                />
              )}
            </SettingsCard>
          </Section>

          {/* ===== 原始数据 (默认收起) ===== */}
          <Section>
            <SectionTitle title={zh ? '原始数据' : 'Raw data'} />
            <SettingsCard>
              <SettingsRow
                leading={<RowIcon src={NeoxIllus.files} />}
                title={zh ? '会话 JSON' : 'Session JSON'}
                desc={zh ? '这段对话的完整记录，可复制或导出。' : 'The full record of this conversation. Copy or export.'}
                onClick={() => setRawOpen((o) => !o)}
                control={(
                  <svg className={`ctx3-chev${rawOpen ? ' is-open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
                )}
              />
              {rawOpen && (
                <SettingsRow className="ctx3-raw">
                  <ContextDataViewer language={language} />
                </SettingsRow>
              )}
            </SettingsCard>
          </Section>
        </>
      )}
    </div>
  );
};

export default ContextTab;
