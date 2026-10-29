/**
 * KeymapTab — Keyboard shortcut customization (IntelliJ-style)
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import Icons from '../../../components/Icons';
import { confirmAsync } from '../../../components/confirmEvents';
import { PageTitle, NeoxButton } from '../../../components/settings-base';
import { useI18n } from '../../../hooks/useI18n';
import {
  KEYMAP_ACTIONS,
  type KeymapAction,
  type KeymapActionId,
  type KeymapCategory,
  getKeymapBindings,
  setBinding,
  resetBinding,
  resetAllBindings,
  formatShortcut,
  eventToShortcut,
  findConflicts,
  isMac,
  subscribeKeymap,
  actionName,
  actionDescription,
  categoryLabel,
} from '../../../utils/keymap';

const KeymapTab: React.FC<{ embedded?: boolean }> = ({ embedded }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [bindings, setBindings] = useState(() => getKeymapBindings());
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<KeymapActionId | null>(null);
  const [captureValue, setCaptureValue] = useState('');
  const captureRef = useRef<HTMLInputElement>(null);

  // Subscribe to live binding changes
  useEffect(() => {
    return subscribeKeymap(() => setBindings({ ...getKeymapBindings() }));
  }, []);

  // ── Filter & group ──
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return KEYMAP_ACTIONS;
    return KEYMAP_ACTIONS.filter((a) => {
      const binding = bindings[a.id] || '';
      return (
        /* 两种语言都参与匹配: 英文界面下看到的是英文名, 只搜中文字段等于搜不到;
         * 但也不能只搜英文 —— 中文用户切过语言后仍可能按记忆里的中文名搜。 */
        a.name.toLowerCase().includes(q) ||
        (a.nameEn || '').toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        (a.descriptionEn || '').toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        binding.toLowerCase().includes(q) ||
        formatShortcut(binding).toLowerCase().includes(q)
      );
    });
  }, [search, bindings]);

  const grouped = useMemo(() => {
    const groups = new Map<KeymapCategory, KeymapAction[]>();
    for (const a of filtered) {
      const arr = groups.get(a.category);
      if (arr) arr.push(a);
      else groups.set(a.category, [a]);
    }
    return Array.from(groups.entries());
  }, [filtered]);

  // ── Capture handlers ──
  const startEdit = useCallback((id: KeymapActionId) => {
    setEditingId(id);
    setCaptureValue('');
    setTimeout(() => captureRef.current?.focus(), 30);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setCaptureValue('');
  }, []);

  const handleCaptureKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') { cancelEdit(); return; }
    if (e.key === 'Tab') return;

    const captured = eventToShortcut(e);
    if (captured) setCaptureValue(captured);
  }, [cancelEdit]);

  const saveCapture = useCallback(() => {
    if (editingId && captureValue) {
      setBinding(editingId, captureValue);
    }
    cancelEdit();
  }, [editingId, captureValue, cancelEdit]);

  const clearBinding = useCallback((id: KeymapActionId) => {
    setBinding(id, '');
  }, []);

  const handleResetOne = useCallback((id: KeymapActionId) => {
    resetBinding(id);
  }, []);

  const handleResetAll = useCallback(async () => {
    const ok = await confirmAsync({
      title: zh ? '恢复默认快捷键' : 'Reset shortcuts',
      message: zh ? '确定要将所有快捷键恢复为默认值吗？' : 'Reset every shortcut back to its default?',
      confirmLabel: zh ? '恢复默认' : 'Reset',
    });
    if (ok) {
      resetAllBindings();
    }
  }, []);

  // ── Render row ──
  const renderRow = (action: KeymapAction) => {
    const binding = bindings[action.id] || '';
    const isEditing = editingId === action.id;
    const conflicts = isEditing && captureValue
      ? findConflicts(captureValue, action.id)
      : [];

    return (
      <div key={action.id} className={`keymap-row ${isEditing ? 'editing' : ''}`}>
        <div className="keymap-row-info">
          <div className="keymap-row-name">{actionName(action, zh)}</div>
          <div className="keymap-row-desc">{actionDescription(action, zh)}</div>
        </div>

        <div className="keymap-row-shortcut">
          {isEditing ? (
            <div className="keymap-capture-wrap">
              <input
                ref={captureRef}
                type="text"
                className={`keymap-capture-input ${conflicts.length > 0 ? 'has-conflict' : ''}`}
                value={captureValue ? formatShortcut(captureValue) : ''}
                onKeyDown={handleCaptureKeyDown}
                placeholder={zh ? '按下快捷键...' : 'Press a shortcut…'}
                readOnly
              />
              {conflicts.length > 0 && (
                <div className="keymap-conflict-warn">
                  {(() => {
                    const other = KEYMAP_ACTIONS.find(a => a.id === conflicts[0]);
                    const label = other ? actionName(other, zh) : '';
                    return zh ? `与「${label}」冲突` : `Conflicts with “${label}”`;
                  })()}
                </div>
              )}
              <div className="keymap-capture-actions">
                <button
                  className="keymap-mini-btn primary"
                  onClick={saveCapture}
                  disabled={!captureValue}
                >{zh ? '保存' : 'Save'}</button>
                <button className="keymap-mini-btn" onClick={cancelEdit}>{zh ? '取消' : 'Cancel'}</button>
              </div>
            </div>
          ) : (
            <>
              <div
                className={`keymap-shortcut-chip ${binding ? '' : 'empty'}`}
                onClick={() => startEdit(action.id)}
                role="button"
                tabIndex={0}
              >
                {binding ? formatShortcut(binding) : (zh ? '未绑定' : 'Not bound')}
              </div>
              <div className="keymap-row-actions">
                <button
                  className="keymap-icon-btn"
                  onClick={() => handleResetOne(action.id)}
                  title={zh ? '恢复默认' : 'Reset to default'}
                >
                  <Icons.Refresh />
                </button>
                {binding && (
                  <button
                    className="keymap-icon-btn"
                    onClick={() => clearBinding(action.id)}
                    title={zh ? '清除' : 'Clear'}
                  >
                    <Icons.X />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="settings-panel-content keymap-panel">
      {/* Phase 2A: 顶部 scaffold 换成 PageTitle (其他 hero 视觉 keymap-search/keymap-row 保留) */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        {embedded
          ? <h3 className="nx-section-title__title" style={{ margin: 0 }}>{zh ? '键盘快捷键' : 'Keyboard shortcuts'}</h3>
          : <PageTitle title={zh ? '键盘快捷键' : 'Keyboard shortcuts'} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="keymap-platform-badge">{isMac ? 'macOS' : 'Windows / Linux'}</span>
          <NeoxButton variant="ghost" size="sm" onClick={handleResetAll} leading={<Icons.Refresh />}>
            {zh ? '全部恢复默认' : 'Reset all'}
          </NeoxButton>
        </div>
      </div>

      <div className="keymap-scope-hint">
        <Icons.Lightbulb />
        <span>{zh
          ? '在左侧文件树里生效。对话里用 ⌘K 搜索会话、⌘N 新建会话，代码面板里用 ⌘L 把代码加到对话。'
          : 'Apply in the file tree. In chat use ⌘K to search and ⌘N for a new chat; in the code panel ⌘L adds code to chat.'}</span>
      </div>

      <div className="keymap-search-bar">
        <Icons.Search />
        <input
          type="text"
          className="keymap-search-input nx-bare-input"
          placeholder={zh ? '搜索操作或快捷键...' : 'Search actions or shortcuts…'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
        {search && (
          <button className="keymap-search-clear" onClick={() => setSearch('')} title={zh ? '清空搜索' : 'Clear search'} aria-label={zh ? '清空搜索' : 'Clear search'}>
            <Icons.X />
          </button>
        )}
      </div>

      <div className="keymap-list">
        {grouped.length === 0 ? (
          <div className="keymap-empty">{zh ? '未找到匹配的快捷键' : 'No matching shortcut'}</div>
        ) : (
          grouped.map(([category, actions]) => (
            <section key={category} className="keymap-block">
              <h2 className="keymap-block__label">{categoryLabel(category, zh)}</h2>
              <div className="keymap-group">
                <div className="keymap-group-rows">
                  {actions.map(renderRow)}
                </div>
              </div>
            </section>
          ))
        )}
      </div>

      <div className="keymap-footer-hint">
        <Icons.Lightbulb />
        <span>{zh ? '默认快捷键基于 IntelliJ IDEA。点击任一快捷键可重新绑定，按 Esc 取消。' : 'Defaults follow IntelliJ IDEA. Click a shortcut to rebind it; Esc cancels.'}</span>
      </div>
    </div>
  );
};

export default KeymapTab;
