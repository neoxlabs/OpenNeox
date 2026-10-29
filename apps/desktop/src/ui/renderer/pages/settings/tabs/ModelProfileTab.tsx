import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import { PageTitle, Segmented } from '../../../components/settings-base';
import { ProfileFieldGroups, buildFieldGroups, pickPath } from './ModelProfileFields';
import { ModelFitSimple } from './ModelFitSimple';
import { NeoxIllus } from '../../../media/illus';
import './ModelProfileTab.clay.css';

/**
 * ModelProfileTab - renders model profile / toolset override management.
 *
 * Extracted from SettingsPage.renderModelProfileContent.
 * All state and handlers come from SettingsContext.
 */
const ModelProfileTab: React.FC = () => {
  const {
    modelProfile,
    selectedModelProfile,
    allModelProfiles,
    filteredModelProfiles,
    modelProfileQuery,
    setModelProfileQuery,
    toolsetOverrideText,
    setToolsetOverrideText,
    toolsetOverrideSource,
    toolsetOverrideLoading,
    toolsetOverrideSaving,
    toolPaletteQuery,
    setToolPaletteQuery,
    selectedOverrideTools,
    filteredToolCandidates,
    toolDescByName,
    loadModelProfile,
    handleSelectModelProfile,
    toggleOverrideTool,
    handleSaveModelToolsetOverride,
    handleResetModelToolsetOverride,
  } = useSettingsContext();
  const { language } = useI18n();

  const [resolvedProfile, setResolvedProfile] = useState<any>(null);
  const [resolveLoading, setResolveLoading] = useState(false);
  const [fieldSaving, setFieldSaving] = useState(false);
  const fieldGroups = useMemo(() => buildFieldGroups(language === 'zh'), [language]);

  const reloadResolved = useCallback(async (target?: { model?: string; providerId?: string }) => {
    const model = target?.model ?? selectedModelProfile?.model;
    if (!model) { setResolvedProfile(null); return; }
    setResolveLoading(true);
    try {
      const res = await (window.neox as any).modelProfileResolve?.({
        model,
        providerId: target?.providerId ?? selectedModelProfile?.providerId,
      });
      setResolvedProfile(res?.success ? res : null);
    } catch (err) {
      console.error('[modelProfile] resolve failed:', err);
      setResolvedProfile(null);
    } finally {
      setResolveLoading(false);
    }
  }, [selectedModelProfile?.model, selectedModelProfile?.providerId]);

  useEffect(() => { void reloadResolved(); }, [reloadResolved]);

  const overriddenCount = useMemo(() => {
    const ov = resolvedProfile?.overrides;
    if (!ov) return 0;
    return fieldGroups.reduce((n, g) => n + g.fields.filter(f => pickPath(ov, f.path) !== undefined).length, 0);
  }, [resolvedProfile, fieldGroups]);

  const handleFieldOverride = useCallback(async (path: string, value: unknown) => {
    const model = selectedModelProfile?.model;
    if (!model) return;
    setFieldSaving(true);
    try {
      const res = await (window.neox as any).modelProfileSetFieldOverride?.({ model, path, value });
      if (res && res.success === false) console.error('[modelProfile] set override failed:', res.error);
      await reloadResolved();
    } finally {
      setFieldSaving(false);
    }
  }, [selectedModelProfile?.model, reloadResolved]);

  const handleResetAllFields = useCallback(async () => {
    const model = selectedModelProfile?.model;
    const ov = resolvedProfile?.overrides;
    if (!model || !ov) return;
    setFieldSaving(true);
    try {
      /* 逐条清 —— 白名单校验在主进程, 这里只清我们自己渲染过的那些路径 */
      for (const g of fieldGroups) {
        for (const f of g.fields) {
          if (pickPath(ov, f.path) === undefined) continue;
          await (window.neox as any).modelProfileSetFieldOverride?.({ model, path: f.path, value: null });
        }
      }
      await reloadResolved();
    } finally {
      setFieldSaving(false);
    }
  }, [selectedModelProfile?.model, resolvedProfile, fieldGroups, reloadResolved]);

  const [fitMode, setFitMode] = useState<'simple' | 'geek'>(() => {
    try { return localStorage.getItem('neox-model-fit-mode') === 'geek' ? 'geek' : 'simple'; } catch { return 'simple'; }
  });
  const switchFitMode = useCallback((m: 'simple' | 'geek') => {
    setFitMode(m);
    try { localStorage.setItem('neox-model-fit-mode', m); } catch { /* ignore */ }
  }, []);
  const toolSectionRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollToTools, setScrollToTools] = useState(false);
  useEffect(() => {
    if (!scrollToTools || fitMode !== 'geek') return;
    setScrollToTools(false);
    requestAnimationFrame(() => toolSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [scrollToTools, fitMode]);

  const selectedIsCurrent = !!selectedModelProfile
    && !!modelProfile
    && selectedModelProfile.model === modelProfile.model
    && selectedModelProfile.providerId === modelProfile.providerId;

  return (
    <div className="settings-panel-content model-profile-panel mf3">
      <div className="mp-titlebar">
        <PageTitle
          title={language === 'zh' ? '模型适配' : 'Model Adaptation'}
          subtitle={fitMode === 'simple' ? (language === 'zh' ? '对症调整 · 只对所选模型生效' : 'Fix by symptom · applies to the selected model only') : undefined}
        />
        <Segmented
          value={fitMode}
          onChange={switchFitMode}
          aria-label={language === 'zh' ? '显示方式' : 'View'}
          options={[
            { value: 'simple', label: language === 'zh' ? '简单' : 'Simple' },
            { value: 'geek', label: language === 'zh' ? '极客' : 'Expert' },
          ]}
        />
      </div>

      {!modelProfile ? (
        <div className="remote-empty-clients" style={{ padding: '32px 0' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
            <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" />
          </svg>
          <span>{language === 'zh' ? '无模型数据' : 'No model data'}</span>
        </div>
      ) : fitMode === 'simple' ? (
        <ModelFitSimple
          models={allModelProfiles}
          selected={selectedModelProfile}
          current={modelProfile}
          onSelect={(mp) => void handleSelectModelProfile(mp)}
          resolved={resolvedProfile}
          loading={resolveLoading}
          busy={fieldSaving}
          overriddenCount={overriddenCount}
          onSet={(path, value) => handleFieldOverride(path, value)}
          onResetAll={() => void handleResetAllFields()}
          onToolsChanged={() => { if (selectedModelProfile) void handleSelectModelProfile(selectedModelProfile); }}
          onOpenToolList={() => { switchFitMode('geek'); setScrollToTools(true); }}
        />
      ) : (
        <>
        {selectedModelProfile && (
          <section className="mp-geek-banner">
            <img className="mp-geek-banner__art" src={NeoxIllus.fitHero} alt="" draggable={false} />
            <div className="mp-geek-banner__main">
              <span className="mp-geek-banner__kicker">{language === 'zh' ? '当前调整' : 'Editing'}</span>
              <span className="mp-geek-banner__model">{selectedModelProfile.model}</span>
              <span className="mp-geek-banner__meta">
                {selectedModelProfile.providerName}
                <span className="mp-mini-tag">{language === 'zh' ? '适配包' : 'Profile'} #{resolvedProfile?.profileId || selectedModelProfile.profileId || '-'}</span>
                {selectedIsCurrent && <span className="mp-mini-tag accent">{language === 'zh' ? '正在用' : 'In use'}</span>}
              </span>
            </div>
            <div className="mp-geek-banner__stats">
              <span><b>{overriddenCount}</b>{language === 'zh' ? '已修改' : 'Modified'}</span>
              <span><b>{selectedOverrideTools.length}</b>{language === 'zh' ? '已关闭工具' : 'Tools off'}</span>
            </div>
          </section>
        )}
        <div className="mp-workbench">
          <section className="mp-pane mp-models-pane">
            <div className="mp-section-head">
              <h3>{language === 'zh' ? '模型列表' : 'Models'}</h3>
              <span className="mp-count-badge">{filteredModelProfiles.length}/{allModelProfiles.length}</span>
              <button className="mp-refresh-btn" onClick={loadModelProfile} title={language === 'zh' ? '刷新' : 'Refresh'} aria-label={language === 'zh' ? '刷新' : 'Refresh'}>
                <Icons.Refresh />
              </button>
            </div>
            <div className="mp-search">
              <Icons.Search />
              <input
                type="text"
                className="nx-bare-input"
                value={modelProfileQuery}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setModelProfileQuery(e.target.value)}
                placeholder={language === 'zh' ? '搜索模型 / Provider / Profile' : 'Search model / provider / profile'}
              />
            </div>
            <div className="mp-model-list">
              {filteredModelProfiles.length === 0 && (
                <div className="mp-list-empty">
                  {language === 'zh' ? '未匹配到模型' : 'No matched models'}
                </div>
              )}
              {filteredModelProfiles.map((mp: any, idx: number) => {
                const selected = selectedModelProfile?.providerId === mp.providerId && selectedModelProfile?.model === mp.model;
                const isCurrent = modelProfile.providerId === mp.providerId && modelProfile.model === mp.model;
                return (
                  <button
                    key={`${mp.providerId}:${mp.model}:${idx}`}
                    className={`mp-model-item ${selected ? 'active' : ''}`}
                    onClick={() => void handleSelectModelProfile(mp)}
                  >
                    <div className="mp-model-main">
                      <span className="mp-model-name">{mp.model}</span>
                      <span className="mp-model-provider">{mp.providerName}</span>
                    </div>
                    <div className="mp-model-meta">
                      <span className="mp-mini-tag">#{mp.profileId}</span>
                      {isCurrent && <span className="mp-mini-tag accent">{language === 'zh' ? '当前' : 'Current'}</span>}
                      {!!mp.modelOverrideDisabledTools && <span className="mp-mini-tag good">{language === 'zh' ? '模型覆盖' : 'Model'}</span>}
                      {!mp.modelOverrideDisabledTools && !!mp.profileOverrideDisabledTools && <span className="mp-mini-tag">{language === 'zh' ? 'Profile 覆盖' : 'Profile'}</span>}
                      {(mp.disabledTools?.length || 0) > 0 && (
                        <span className="mp-mini-tag warn">{mp.disabledTools.length} {language === 'zh' ? '禁用' : 'disabled'}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="mp-right-column">
            <div className="mp-section">
              <div className="mp-section-head">
                <h3>{language === 'zh' ? '参数' : 'Settings'}</h3>
              </div>
              {!selectedModelProfile ? (
                <span className="mp-list-empty">
                  {language === 'zh' ? '在左边选一个模型' : 'Pick a model on the left'}
                </span>
              ) : resolveLoading ? (
                <span className="mp-list-empty neox-text-shimmer">{language === 'zh' ? '读取中…' : 'Loading…'}</span>
              ) : !resolvedProfile ? (
                /* 静默失败会让整栏看起来像"什么都没配", 必须说清是没读到 */
                <span className="mp-list-empty">
                  {language === 'zh'
                    ? '读不到这个模型的适配。若刚更新过应用，重启一次即可。'
                    : 'Could not read this model’s adaptation. If the app was just updated, restart it.'}
                </span>
              ) : (
                <ProfileFieldGroups
                  groups={fieldGroups}
                  effective={resolvedProfile?.effective}
                  builtin={resolvedProfile?.builtin}
                  overrides={resolvedProfile?.overrides || {}}
                  overriddenCount={overriddenCount}
                  disabled={fieldSaving}
                  onChange={handleFieldOverride}
                  onResetAll={handleResetAllFields}
                />
              )}
            </div>

            {selectedModelProfile && (
              <div className="mp-section" ref={toolSectionRef}>
                <div className="mp-section-head mp-section-head--art">
                  <img className="mp-section-head__art" src={NeoxIllus.fitEdit} alt="" draggable={false} />
                  <h3>{language === 'zh' ? '工具' : 'Tools'}</h3>
                  <span className={`usg-success-rate ${toolsetOverrideSource === 'model' ? 'good' : ''}`} style={{ fontSize: '10px' }}>
                    {toolsetOverrideSource === 'model'
                      ? (language === 'zh' ? '模型覆盖' : 'Model Override')
                      : toolsetOverrideSource === 'profile'
                        ? (language === 'zh' ? 'Profile 覆盖' : 'Profile Override')
                        : (language === 'zh' ? '内置默认' : 'Builtin')}
                  </span>
                </div>

                <p className="mp-section-hint">
                  {language === 'zh'
                    ? '关闭的工具对该模型不可见，也无法调用。'
                    : 'Disabled tools are hidden from this model and blocked.'}
                </p>

                <div className="mp-toolbar">
                  <div className="mp-search">
                    <Icons.Search />
                    <input
                      type="text"
                      className="nx-bare-input"
                      value={toolPaletteQuery}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setToolPaletteQuery(e.target.value)}
                      placeholder={language === 'zh' ? '搜索工具' : 'Search tools'}
                    />
                  </div>
                  <span className="mp-tool-count">
                    {language === 'zh'
                      ? `${selectedOverrideTools.length} / ${filteredToolCandidates.length} 已关闭`
                      : `${selectedOverrideTools.length} of ${filteredToolCandidates.length} off`}
                  </span>
                </div>

                <div className="mp-tool-table">
                  {filteredToolCandidates.length === 0 && (
                    <span className="mp-list-empty">
                      {language === 'zh' ? '没有匹配的工具' : 'No matching tools'}
                    </span>
                  )}
                  {filteredToolCandidates.map((name: string) => {
                    const off = selectedOverrideTools.includes(name);
                    const desc = toolDescByName?.get?.(name) || '';
                    return (
                      <button
                        key={name}
                        type="button"
                        className={`mp-tool-line ${off ? 'off' : ''}`}
                        disabled={toolsetOverrideLoading || toolsetOverrideSaving}
                        onClick={() => toggleOverrideTool(name)}
                        title={off
                          ? (language === 'zh' ? '点击恢复这个工具' : 'Click to re-enable')
                          : (language === 'zh' ? '点击对这个模型关掉它' : 'Click to disable for this model')}
                      >
                        <span className="mp-tool-line__main">
                          <span className="mp-tool-line__name">{name}</span>
                          {desc && <span className="mp-tool-line__desc">{desc}</span>}
                        </span>
                        <span className={`nx-tag ${off ? 'nx-tag--err' : 'nx-tag--ok'}`}>
                          {off ? (language === 'zh' ? '已关闭' : 'Off') : (language === 'zh' ? '可用' : 'On')}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <details className="mp-advanced">
                  <summary>{language === 'zh' ? '按名称编辑' : 'Edit as text'}</summary>
                <textarea
                  className="mp-manual-editor"
                  value={toolsetOverrideText}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setToolsetOverrideText(e.target.value)}
                  placeholder={language === 'zh' ? '每行一个工具名' : 'One tool name per line'}
                  disabled={toolsetOverrideLoading || toolsetOverrideSaving}
                />

                </details>

                <div className="mp-actions">
                  <button className="btn-secondary" disabled={toolsetOverrideSaving || toolsetOverrideLoading} onClick={handleResetModelToolsetOverride}>
                    {language === 'zh' ? '重置' : 'Reset'}
                  </button>
                  <button className="btn-primary" disabled={toolsetOverrideSaving || toolsetOverrideLoading} onClick={handleSaveModelToolsetOverride}>
                    {toolsetOverrideSaving
                      ? (language === 'zh' ? '保存中…' : 'Saving…')
                      : (language === 'zh' ? '保存' : 'Save')}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
        </>
      )}
    </div>
  );
};

export default ModelProfileTab;
