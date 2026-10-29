import React from 'react';
import { createPortal } from 'react-dom';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import { useEscClose } from '../../../hooks/useEscClose';
import Icons from '../../../components/Icons';
import { NeoxButton, PageTitle, SettingsCard, SwitchRow } from '../../../components/settings-base';
import { NeoxIllus } from '../../../media/illus';
import './RoutingTab.clay.css';

/**
 * RoutingTab - renders model routing configuration.
 * All state and callbacks come from SettingsContext.
 */
const RoutingTab: React.FC = () => {
  const { t, language } = useI18n();
  const {
    routingEnabled,
    handleRoutingToggle,
    modelRoutes,
    providers,
    resetRouteForm,
    setShowAddRouteForm,
    showAddRouteForm,
    editingRoute,
    setEditingRoute,
    routeFormAlias,
    setRouteFormAlias,
    routeFormStrategy,
    setRouteFormStrategy,
    routeFormProviders,
    setRouteFormProviders,
    handleDeleteRoute,
    handleSaveRoute,
    handleSelectProviderModel,
    handleRemoveProviderFromRoute,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    draggedIndex,
    providerDropdownRef,
    providerDropdownMenuRef,
    dropdownTriggerRef,
    toggleProviderDropdown,
    providerDropdownOpen,
    dropdownPosition,
    getProviderHealthStatus,
  } = useSettingsContext();

  /* Esc 关掉路由编辑弹窗 — capture 层拦截, 不会穿透把整个设置页关掉 */
  useEscClose(showAddRouteForm, () => setShowAddRouteForm(false));

  const selectableProviders = React.useMemo(
    () => (providers || []).filter((p: any) => (p.models?.length || 0) > 0),
    [providers],
  );

  const zh = language === 'zh';
  const routeEntries = Object.entries(modelRoutes) as Array<[string, any]>;
  const strategyMeta: Record<string, { name: string; desc: string }> = {
    priority: { name: zh ? '按顺序' : 'In order', desc: zh ? '先用第一家，不可用再换下一家' : 'Use the first; fall back to the next' },
    latency: { name: zh ? '选最快' : 'Fastest', desc: zh ? '自动用当前延迟最低的一家' : 'Use whichever is fastest now' },
    'round-robin': { name: zh ? '轮流' : 'Round robin', desc: zh ? '请求平均分给每一家' : 'Spread requests evenly' },
  };
  const healthOf = (providerId: string) => {
    const h = getProviderHealthStatus(providerId);
    const tone = h.status === 'healthy' ? 'ok' : h.status === 'degraded' ? 'warn' : h.status === 'unhealthy' ? 'bad' : 'unknown';
    return { tone, latency: h.latency ? `${h.latency}ms` : '' };
  };
  const openNew = () => { resetRouteForm(); setShowAddRouteForm(true); };
  const openEdit = (route: any) => {
    setEditingRoute(route);
    setRouteFormAlias(route.modelAlias);
    setRouteFormStrategy(route.strategy);
    setRouteFormProviders(route.routes);
    setShowAddRouteForm(true);
  };

  return (
    <div className="settings-panel-content routing-page rt3">
      <PageTitle
        title={t.settings.routing.title}
        subtitle={zh ? '一个模型，多家服务商兜底' : 'One model, several providers as backup'}
      />

      <div className="mfs">
        <SettingsCard className="rt3-enable">
          <SwitchRow
            leading={<span className="rt3-ico"><Icons.GitFork /></span>}
            title={<>{t.settings.routing.enable}<span className="rt3-state">{routingEnabled
              ? (zh ? `已启用 · ${routeEntries.length} 条路由` : `On · ${routeEntries.length} routes`)
              : (zh ? '未启用 · 只用单一服务商' : 'Off · single provider only')}</span></>}
            ariaLabel={t.settings.routing.enable}
            desc={zh ? '某一家不可用时自动换下一家。建好后在模型菜单里选这个名字即可。' : 'If one provider fails, the next takes over. Pick the route name in the model menu.'}
            checked={routingEnabled}
            onChange={() => handleRoutingToggle()}
          />
        </SettingsCard>

        <div className="rt-list-head">
          <h4>{zh ? '路由列表' : 'Routes'}</h4>
          <NeoxButton size="sm" onClick={openNew}>
            <Icons.Plus />
            <span>{zh ? '新建路由' : 'New route'}</span>
          </NeoxButton>
        </div>

        {routeEntries.length === 0 ? (
          <button type="button" className="rt-empty" onClick={openNew}>
            <img src={NeoxIllus.routeFailover} alt="" draggable={false} />
            <span className="rt-empty__title">{zh ? '还没有路由' : 'No routes yet'}</span>
            <span className="rt-empty__desc">{zh ? '把同一个模型挂到几家服务商上，点这里新建。' : 'Attach one model to several providers. Click to create.'}</span>
          </button>
        ) : (
          <div className="rt-list">
            {routeEntries.map(([alias, route]) => {
              const enabledRoutes = (route.routes || []).filter((r: any) => r.enabled !== false);
              const sm = strategyMeta[route.strategy] ?? { name: route.strategy, desc: '' };
              return (
                <div key={alias} className={`rt-card${routingEnabled ? '' : ' is-idle'}`}>
                  <div className="rt-card__top">
                    <span className="rt3-ico"><Icons.GitFork /></span>
                    <span className="rt-card__info">
                      <span className="rt-card__alias">{route.displayName || alias}</span>
                      <span className="rt-card__sub" title={sm.desc}>
                        {sm.name} · {enabledRoutes.length} {zh ? '家' : enabledRoutes.length === 1 ? 'provider' : 'providers'}
                      </span>
                    </span>
                    <span className="rt-card__acts">
                      <button type="button" onClick={() => openEdit(route)} title={zh ? '编辑' : 'Edit'} aria-label={zh ? '编辑这条路由' : 'Edit route'}><Icons.Edit /></button>
                      <button type="button" className="danger" onClick={() => handleDeleteRoute(alias)} title={zh ? '删除' : 'Delete'} aria-label={zh ? '删除这条路由' : 'Delete route'}><Icons.Trash /></button>
                    </span>
                  </div>
                  <div className="rt-flow">
                    {enabledRoutes.length === 0 && <span className="rt-flow__none">{zh ? '没有启用的服务商' : 'No enabled providers'}</span>}
                    {enabledRoutes.map((r: any, i: number) => {
                      const provider = providers.find((p: any) => p.id === r.providerId);
                      const h = healthOf(r.providerId);
                      return (
                        <React.Fragment key={`${r.providerId}:${r.modelName}:${i}`}>
                          {i > 0 && <span className="rt-flow__arrow" aria-hidden="true">{route.strategy === 'priority' ? '→' : '·'}</span>}
                          <span className="rt-node">
                            {route.strategy === 'priority' && <b>{i + 1}</b>}
                            <span className={`rt-dot rt-dot--${h.tone}`} />
                            <span className="rt-node__name">{provider?.name || r.providerId}</span>
                            <span className="rt-node__model">{r.modelName}</span>
                            {h.latency && <em>{h.latency}</em>}
                          </span>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 添加/编辑路由模态框 - 按照文档设计 */}
      {showAddRouteForm && (
        <div className="modal-overlay" onClick={() => setShowAddRouteForm(false)}>
          <div className="modal-content route-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingRoute ? (zh ? '编辑路由' : 'Edit route') : (zh ? '新建路由' : 'New route')}</h3>
              <button className="close-btn" onClick={() => setShowAddRouteForm(false)} title={language === 'zh' ? '关闭' : 'Close'} aria-label={language === 'zh' ? '关闭' : 'Close'}>
                <Icons.Close />
              </button>
            </div>
            <div className="modal-body">
              {/* 模型别名 */}
              <div className="form-group">
                <label>{zh ? '路由名称' : 'Route name'}</label>
                <input
                  type="text"
                  value={routeFormAlias}
                  onChange={e => setRouteFormAlias(e.target.value)}
                  placeholder={zh ? '例：claude-sonnet（会出现在模型菜单里）' : 'e.g. claude-sonnet (shown in the model menu)'}
                  disabled={!!editingRoute}
                />
              </div>

              <div className="form-group">
                <label>{zh ? '怎么选服务商' : 'How to pick'}</label>
                <div className="rt-strategies" role="radiogroup">
                  {(['priority', 'latency', 'round-robin'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={routeFormStrategy === s}
                      className={`rt-strategy${routeFormStrategy === s ? ' is-on' : ''}`}
                      onClick={() => setRouteFormStrategy(s)}
                    >
                      <b>{strategyMeta[s].name}</b>
                      <span>{strategyMeta[s].desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Provider 列表 - 表格样式 */}
              <div className="form-group">
                <label>{zh ? '服务商（拖动调整顺序）' : 'Providers (drag to reorder)'}</label>
                <div className="provider-table">
                  {routeFormProviders.length === 0 ? (
                    <div className="empty-providers">
                      <p>{zh ? '还没有服务商，从下方添加' : 'No providers yet — add one below'}</p>
                    </div>
                  ) : (
                    <div className="provider-table-body">
                      {routeFormProviders.map((p: any, index: number) => {
                        const provider = providers.find((pr: any) => pr.id === p.providerId);
                        const h = healthOf(p.providerId);

                        return (
                          <div
                            key={index}
                            className={`provider-table-row ${draggedIndex === index ? 'dragging' : ''}`}
                            draggable
                            onDragStart={() => handleDragStart(index)}
                            onDragOver={(e) => handleDragOver(e, index)}
                            onDragEnd={handleDragEnd}
                          >
                            <span className="col-drag drag-handle">☰</span>
                            <span className="col-provider">
                              <span className="priority-badge">[{index + 1}]</span>
                              {provider?.name || p.providerId}
                            </span>
                            <span className="col-model" title={p.modelName}>
                              {p.modelName.length > 20 ? p.modelName.slice(0, 20) + '...' : p.modelName}
                            </span>
                            <span className="col-status">
                              <span className={`rt-dot rt-dot--${h.tone}`} />
                              <span className="status-latency">{h.latency || '—'}</span>
                            </span>
                            <span className="col-action">
                              <button
                                className="remove-btn"
                                onClick={() => handleRemoveProviderFromRoute(index)}
                              >
                                ×
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* 添加 Provider 自定义下拉 */}
                  <div className="provider-dropdown-container" ref={providerDropdownRef}>
                    <button
                      ref={dropdownTriggerRef}
                      className="provider-dropdown-trigger"
                      onClick={toggleProviderDropdown}
                      type="button"
                    >
                      <Icons.Plus />
                      <span>{zh ? '添加服务商' : 'Add provider'}</span>
                      <span className="dropdown-arrow">{providerDropdownOpen ? '▲' : '▼'}</span>
                    </button>
                    {providerDropdownOpen && createPortal(
                      <div
                        ref={providerDropdownMenuRef}
                        className="provider-dropdown-menu route-provider-dropdown-menu"
                        style={{
                          top: dropdownPosition.top,
                          left: dropdownPosition.left,
                          width: dropdownPosition.width,
                          maxHeight: dropdownPosition.maxHeight,
                        }}
                      >
                        {selectableProviders.length === 0 ? (
                          <div className="provider-dropdown-empty">
                            {language === 'zh' ? '暂无可用的 Provider' : 'No providers available'}
                          </div>
                        ) : (
                          selectableProviders.map((provider: any) => {
                            const isProviderUsed = routeFormProviders.some((p: any) => p.providerId === provider.id);
                            return (
                              <div key={provider.id} className="provider-dropdown-group">
                                <div className="provider-dropdown-group-label">
                                  {provider.name}
                                  {isProviderUsed && <span className="used-tag">{language === 'zh' ? '已添加' : 'Added'}</span>}
                                </div>
                                <div className="provider-dropdown-models">
                                  {provider.models.map((model: any) => (
                                    <button
                                      key={model.name}
                                      className="provider-dropdown-model"
                                      onClick={() => handleSelectProviderModel(provider.id, model.name)}
                                      disabled={isProviderUsed}
                                    >
                                      {model.name}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>,
                      document.body,
                    )}
                  </div>
                </div>
              </div>

              {/* 健康检查为全局配置 (ModelRoutingConfig.healthCheck), 非 per-route。
                  原此处的 per-route 健康检查表单 4 个控件 handleSaveRoute 从不读取、
                  schema (ModelRouteConfig) 也无对应字段 → 纯死表单, 已移除避免误导。 */}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowAddRouteForm(false)}>
                {t.common.cancel}
              </button>
              <button className="btn-primary" onClick={handleSaveRoute}>
                {t.common.save}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RoutingTab;
