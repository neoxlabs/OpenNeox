import React, { useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useEscClose } from '../../../hooks/useEscClose';
import Icons from '../../../components/Icons';
import { confirmAsync } from '../../../components/confirmEvents';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';
import type { StorageInfo, StorageFileInfo } from '../../../../shared/ipc';
import { PageTitle, NeoxButton, Section, SectionTitle, SettingsCard, SettingsRow, RowIcon } from '../../../components/settings-base';
import { revealInFileManagerLabel } from '../../../utils/fileManagerLabels';
import { NeoxIllus } from '../../../media/illus';
import './StorageTab.clay.css';

/**
 * StorageTab - renders storage management (hero overview, cleanup, advanced file list).
 * Fully self-contained: owns all storage-related state and handlers.
 */
const StorageTab: React.FC = () => {
  const { t, language } = useI18n();

  // ---- state ----
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Record<string, StorageFileInfo[]>>({});
  const [storageAdvancedOpen, setStorageAdvancedOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ path: string; content: string; name: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);

  /* Esc 关掉文件预览弹窗 — capture 层拦截, 不会穿透把整个设置页关掉 */
  useEscClose(!!previewFile, () => setPreviewFile(null));

  // ---- handlers ----

  const loadStorageInfo = async () => {
    setStorageLoading(true);
    try {
      const info = await Promise.race([
        window.neox.getStorageInfo(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('storage-info-timeout')), 12000)),
      ]);
      setStorageInfo(info as Awaited<ReturnType<typeof window.neox.getStorageInfo>>);
    } catch (err) {
      console.error('Failed to load storage info:', err);
      // 不覆盖已有数据 (刷新失败时保留旧值); 仅首次失败时 storageInfo 仍为 null → 显错误态
    }
    setStorageLoading(false);
  };

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const toggleDir = async (dirPath: string) => {
    const newExpanded = new Set(expandedDirs);
    if (newExpanded.has(dirPath)) {
      newExpanded.delete(dirPath);
    } else {
      newExpanded.add(dirPath);
      // 加载目录内容
      if (!dirContents[dirPath]) {
        try {
          const files = await window.neox.listConfigDir(dirPath);
          setDirContents(prev => ({ ...prev, [dirPath]: files }));
        } catch (err) {
          console.error('Failed to list directory:', err);
        }
      }
    }
    setExpandedDirs(newExpanded);
  };

  const previewConfigFile = async (filePath: string, fileName: string) => {
    setPreviewLoading(true);
    try {
      const result = await window.neox.readConfigFile(filePath);
      if (result.error) {
        setPreviewFile({ path: filePath, content: `Error: ${result.error}`, name: fileName });
      } else {
        setPreviewFile({ path: filePath, content: result.content, name: fileName });
      }
    } catch (err: any) {
      setPreviewFile({ path: filePath, content: `Error: ${err.message}`, name: fileName });
    }
    setPreviewLoading(false);
  };

  const openInFinder = async (filePath: string) => {
    try {
      await window.neox.openInFinder(filePath);
    } catch (err) {
      console.error('Failed to open in Finder:', err);
    }
  };

  const handleClearCheckpoint = async (workspacePath: string, workspaceName: string) => {
    const warningMessage = language === 'zh'
      ? `确定要清理「${workspaceName}」的代码回退数据吗？\n\n⚠️ 警告：清理后该项目的所有代码变更将无法回退！`
      : `Are you sure you want to clear checkpoint data for "${workspaceName}"?\n\n⚠️ Warning: After clearing, all code changes in this project cannot be reverted!`;

    if (!(await confirmAsync({
      title: language === 'zh' ? '清理代码回退数据' : 'Clear Checkpoint Data',
      message: warningMessage,
      confirmLabel: language === 'zh' ? '确认清理' : 'Clear',
      variant: 'danger',
    }))) return;

    const op = language === 'zh' ? '清理 checkpoint' : 'Clear checkpoint';
    try {
      const result = await window.neox.clearCheckpointStorage(workspacePath);
      if (result.success) {
        loadStorageInfo();
      } else if (result.error) {
        dispatchOpFailed({ op, message: result.error });
      }
    } catch (err) {
      console.error('Failed to clear checkpoint:', err);
      dispatchOpFailed({ op, message: (err as any)?.message || String(err) });
    }
  };

  const handleClearAllCheckpoints = async () => {
    const warningMessage = language === 'zh'
      ? `确定要清理所有项目的代码回退数据吗？\n\n⚠️ 警告：清理后所有项目的代码变更将无法回退！此操作不可撤销！`
      : `Are you sure you want to clear ALL checkpoint data?\n\n⚠️ Warning: After clearing, code changes in ALL projects cannot be reverted! This action cannot be undone!`;

    if (!(await confirmAsync({
      title: language === 'zh' ? '清理所有 checkpoint' : 'Clear All Checkpoints',
      message: warningMessage,
      confirmLabel: language === 'zh' ? '全部清理' : 'Clear All',
      variant: 'danger',
    }))) return;

    const op = language === 'zh' ? '清理所有 checkpoint' : 'Clear all checkpoints';
    try {
      const result = await window.neox.clearAllCheckpointStorage();
      if (result.success) {
        loadStorageInfo();
      } else if (result.error) {
        dispatchOpFailed({ op, message: result.error });
      }
    } catch (err) {
      console.error('Failed to clear all checkpoints:', err);
      dispatchOpFailed({ op, message: (err as any)?.message || String(err) });
    }
  };

  const [cleaning, setCleaning] = useState<'db' | 'cli' | 'semantic' | null>(null);

  const handleClearStale = async (kind: 'db' | 'cli' | 'semantic') => {
    if (cleaning) return;
    const isDb = kind === 'db';
    const isSemantic = kind === 'semantic';
    const title = isSemantic
      ? (language === 'zh' ? '清理残留索引' : 'Clear orphan indexes')
      : isDb
        ? (language === 'zh' ? '清理旧数据库副本' : 'Clear stale DB backups')
        : (language === 'zh' ? '清理旧版命令行工具' : 'Clear stale CLI binaries');
    const message = isSemantic
      ? (language === 'zh'
        ? '这些索引对应的项目**超过 60 天没打开过**了，删掉不影响你在用的项目。\n\n下次真要用那个项目时会自动重建。'
        : 'These indexes belong to projects you have not opened in over 60 days. Projects you still use are untouched — and any of these rebuilds automatically if you open that project again.')
      : isDb
      ? (language === 'zh'
        ? '这些是历次修复/迁移时隔离下来的旧数据库，不是你当前的数据。\n\n会**保留最新的一份**用于万一的数据恢复，其余全部删除。'
        : 'These are old databases quarantined during past repairs/migrations — not your current data.\n\nThe most recent one is kept for recovery; the rest are deleted.')
      : (language === 'zh'
        ? '这些是升级时留下的旧版本命令行工具，每份约 69 MB。\n\n会**保留最新的一份**作为回退用，其余全部删除。'
        : 'These are older CLI binaries left behind by upgrades (~69 MB each).\n\nThe most recent one is kept for rollback; the rest are deleted.');

    if (!(await confirmAsync({
      title,
      message,
      confirmLabel: language === 'zh' ? '清理' : 'Clean up',
      variant: 'danger',
    }))) return;

    setCleaning(kind);
    const op = title;
    try {
      const r = isSemantic
        ? await window.neox.clearOrphanSemanticIndexes?.()
        : isDb
          ? await window.neox.clearStaleDbBackups?.()
          : await window.neox.clearStaleCliBinaries?.();
      if (r) {
        dispatchHint(
          language === 'zh'
            ? `已清理 ${r.removed} 个文件, 释放 ${formatSize(r.freedBytes)}`
            : `Removed ${r.removed} file(s), freed ${formatSize(r.freedBytes)}`,
          'success',
        );
      }
      loadStorageInfo();
    } catch (err) {
      dispatchOpFailed({ op, message: (err as any)?.message || String(err) });
    } finally {
      setCleaning(null);
    }
  };

  const handleBackupAll = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    const op = language === 'zh' ? '备份数据' : 'Back up data';
    try {
      const result = await window.neox.backupAll();
      if (result.ok && result.path) {
        const sizeText = typeof result.sizeBytes === 'number' ? ` (${formatSize(result.sizeBytes)})` : '';
        dispatchHint(
          language === 'zh'
            ? `备份完成${sizeText}: ${result.path}`
            : `Backup saved${sizeText}: ${result.path}`,
          'success',
        );
      } else if (!result.canceled) {
        dispatchOpFailed({ op, message: result.error || (language === 'zh' ? '未知原因' : 'unknown reason') });
      }
    } catch (err) {
      dispatchOpFailed({ op, message: (err as any)?.message || String(err) });
    }
    setBackupBusy(false);
  };

  // ---- auto-load on mount ----
  useEffect(() => {
    if (!storageInfo && !storageLoading) {
      loadStorageInfo();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- preview modal ----
  const renderPreviewModal = () => {
    if (!previewFile) return null;

    // 尝试解析 JSON
    let formattedContent = previewFile.content;
    let isValidJson = false;
    try {
      const parsed = JSON.parse(previewFile.content);
      formattedContent = JSON.stringify(parsed, null, 2);
      isValidJson = true;
    } catch {
      // 不是有效的 JSON
    }

    return (
      <div className="modal-overlay" onClick={() => setPreviewFile(null)}>
        <div className="modal-content preview-modal" onClick={e => e.stopPropagation()}>
          <div className="preview-header">
            <h3>{previewFile.name}</h3>
            <div className="preview-actions">
              <button
                className="btn-icon"
                onClick={() => openInFinder(previewFile.path)}
                title={revealInFileManagerLabel(language === 'zh')}
              >
                <Icons.ExternalLink />
              </button>
              <button className="btn-icon" onClick={() => setPreviewFile(null)} title={language === 'zh' ? '关闭预览' : 'Close preview'} aria-label={language === 'zh' ? '关闭预览' : 'Close preview'}>
                <Icons.Close />
              </button>
            </div>
          </div>
          <div className="preview-path">{previewFile.path}</div>
          <div className="preview-content">
            {previewLoading ? (
              <div className="preview-loading neox-text-shimmer">{language === 'zh' ? '加载中...' : 'Loading...'}</div>
            ) : (
              <pre className={isValidJson ? 'json-content' : 'text-content'}>
                <code>{formattedContent}</code>
              </pre>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ---- render ----
  const zh = language === 'zh';

  // 把 files + checkpoint 归类成可视化分段. 颜色固定一套, 跟随明暗主题仍清晰.
  const segments = storageInfo ? (() => {
    const META: Record<string, { label: string; color: string }> = {
      'neox.db':          { label: zh ? '数据库' : 'Database',    color: '#6366f1' },
      'neox.db.backups':  { label: zh ? '旧数据库副本' : 'Stale DB backups', color: '#78716c' },
      'models/':          { label: zh ? '语音模型' : 'Voice models', color: '#0ea5e9' },
      'bin/':             { label: zh ? '命令行工具' : 'CLI',     color: '#a855f7' },
      'bin/.stale':       { label: zh ? '旧版命令行工具' : 'Stale CLI', color: '#78716c' },
      'semantic/':        { label: zh ? '代码索引' : 'Code index', color: '#f97316' },
      'semantic/.orphan': { label: zh ? '闲置索引' : 'Stale index', color: '#78716c' },
      'chrome-profiles/': { label: zh ? '浏览器数据' : 'Browser', color: '#14b8a6' },
      'checkpoints/':     { label: zh ? '文件快照' : 'Snapshots', color: '#eab308' },
      'logs/':            { label: zh ? '日志' : 'Logs',          color: '#64748b' },
      'workspaces/':      { label: zh ? '工作区' : 'Workspaces',  color: '#10b981' },
      'config.json':      { label: zh ? '配置' : 'Config',        color: '#94a3b8' },
    };
    const raw = storageInfo.files
      .filter(f => f.size > 0)
      .map(f => ({
        key: f.path,
        name: f.name,
        label: META[f.name]?.label ?? f.name.replace(/\/$/, ''),
        size: f.size,
        color: META[f.name]?.color ?? '#78716c',
      }));
    return raw.sort((a, b) => b.size - a.size);
  })() : [];
  const segTotal = segments.reduce((s, x) => s + x.size, 0) || 1;
  const cpSize = storageInfo?.checkpointTotalSize ?? 0;

  return (
    <>
    <div className="settings-panel-content st3">
      <div className="mp-titlebar">
        <PageTitle title={t.settings.storage.title} subtitle={zh ? 'Neox 在这台电脑上占了多少地方' : 'How much space Neox takes up on this computer'} />
        <div className="ctx2-titlebar-actions">
          <NeoxButton variant="ghost" size="sm" onClick={loadStorageInfo} title={t.common.refresh} disabled={storageLoading} aria-label={t.common.refresh}>
            <Icons.Refresh />
          </NeoxButton>
        </div>
      </div>

      <div className="settings-list">
        {/* 首次加载才整屏 loader; 已有数据时刷新只让数字静默更新, 不藏起来 */}
        {storageLoading && !storageInfo ? (
          <div className="storage-hero storage-hero--skeleton">
            <div className="sk-line sk-line--lg" />
            <div className="sk-bar" />
            <div className="sk-legend"><span /><span /><span /></div>
          </div>
        ) : storageInfo ? (
          <>
            {/* ===== Hero: 总占用 + 占比条 + 图例 ===== */}
            <div className={`storage-hero${storageLoading ? ' is-refreshing' : ''}`}>
              <div className="storage-hero-main">
              <div className="storage-hero-top">
                <div className="storage-hero-total">
                  <span className="storage-hero-label">{zh ? '总占用' : 'Total used'}</span>
                  <span className="storage-hero-value">{formatSize(storageInfo.totalSize)}</span>
                </div>
                {/* 「打开目录」开的是主配置目录 ~/.neox —— 用户点它是想看自己的配置和日志,
                    不是 userData 里那个只放 SQLite 的目录。 */}
                <button className="storage-hero-open" onClick={() => openInFinder(storageInfo.neoxHomeDir || storageInfo.configDir)}
                  title={storageInfo.neoxHomeDir || storageInfo.configDir}>
                  <Icons.ExternalLink />
                  <span>{zh ? '打开目录' : 'Open folder'}</span>
                </button>
              </div>

              {segments.length > 0 ? (
                <>
                  <div className="storage-bar" role="img"
                    aria-label={zh ? '存储占比' : 'Storage breakdown'}>
                    {segments.map(s => (
                      <div key={s.key} className="storage-bar-seg"
                        style={{ width: `${Math.max((s.size / segTotal) * 100, 1.5)}%`, background: s.color }}
                        title={`${s.label} · ${formatSize(s.size)}`} />
                    ))}
                  </div>
                  <div className="storage-legend">
                    {segments.map(s => {
                      const staleKind = s.name === 'neox.db.backups' ? 'db'
                        : s.name === 'bin/.stale' ? 'cli'
                        : s.name === 'semantic/.orphan' ? 'semantic' : null;
                      const isVoiceModels = s.name === 'models/';
                      return (
                        <div key={s.key} className="storage-legend-item">
                          <span className="lg-dot" style={{ background: s.color }} />
                          <span className="lg-label">{s.label}</span>
                          <span className="lg-size">{formatSize(s.size)}</span>
                          {isVoiceModels && s.size > 0 && (
                            <button
                              type="button"
                              className="lg-clean"
                              onClick={() => {
                                try { localStorage.setItem('neox-settings-initial-tab', 'tts'); } catch { /* ignore */ }
                                window.dispatchEvent(new CustomEvent('neox:open-settings', {
                                  detail: { tab: 'tts', from: 'storage-legend' },
                                }));
                              }}
                              title={zh
                                ? '这些是你自己下载的本地语音模型。去「语音」里逐个选择要删哪个 — 正在用的那个删了就得重下。'
                                : 'These are local voice models you downloaded. Pick which ones to remove in Voice settings — deleting one you use means downloading it again.'}
                            >
                              {zh ? '管理' : 'Manage'}
                            </button>
                          )}
                          {staleKind && s.size > 0 && (
                            <button
                              type="button"
                              className="lg-clean"
                              disabled={cleaning !== null}
                              onClick={() => { void handleClearStale(staleKind); }}
                              title={zh ? '删除这些残留 (保留最新一份)' : 'Delete these leftovers (keeps the newest one)'}
                            >
                              {cleaning === staleKind ? (zh ? '清理中…' : 'Cleaning…') : (zh ? '清理' : 'Clean')}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="storage-bar storage-bar--empty" />
              )}
              </div>
            </div>

            <Section>
              <SectionTitle title={zh ? '备份与清理' : 'Back up & clean'} />
              <SettingsCard>
                {/* 一键备份: ~/.neox + 会话 SQLite + neox-artifacts → zip */}
                <SettingsRow
                  leading={<RowIcon src={NeoxIllus.storeBackup} />}
                  title={zh ? '备份' : 'Back up'}
                  desc={zh ? 'API Key（加密）、会话记录、图片产物，打包成一个 zip。暂不支持一键恢复。' : 'API keys (encrypted), sessions and image output in one zip. No one-click restore yet.'}
                  control={(
                    <NeoxButton size="sm" onClick={() => void handleBackupAll()} disabled={backupBusy}>
                      {backupBusy ? (zh ? '备份中…' : 'Backing up…') : (zh ? '备份' : 'Back up')}
                    </NeoxButton>
                  )}
                />
                <SettingsRow
                  leading={<RowIcon src={NeoxIllus.storeClean} />}
                  title={<>{zh ? '代码回退数据' : 'Rollback data'}{cpSize > 0 && <span className="set-tag">{formatSize(cpSize)}</span>}</>}
                  desc={cpSize > 0
                    ? (zh ? `${storageInfo.checkpoints.length} 个项目。清理后已有改动无法回退，逐个项目清理见「高级」。` : `${storageInfo.checkpoints.length} projects. Cleared changes can’t be reverted. Per project: see Advanced.`)
                    : (zh ? '暂无可清理的回退数据。' : 'Nothing to clear.')}
                  control={cpSize > 0 ? (
                    <button type="button" className="ctx2-danger" onClick={() => void handleClearAllCheckpoints()}>
                      {zh ? '全部清理' : 'Clear all'}
                    </button>
                  ) : undefined}
                />
              </SettingsCard>
            </Section>

            {/* ===== 高级 (折叠): 路径 · 明细 · 逐项清理 ===== */}
            <div className="settings-section storage-advanced-section" style={{ borderBottom: 'none' }}>
              <button className="storage-advanced-toggle" onClick={() => setStorageAdvancedOpen(o => !o)}
                aria-expanded={storageAdvancedOpen}>
                <svg className={`sat-chevron${storageAdvancedOpen ? ' open' : ''}`} width="13" height="13"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 18 6-6-6-6" />
                </svg>
                <span className="sat-label">{zh ? '高级' : 'Advanced'}</span>
                <span className="sat-hint">{zh ? '数据路径 · 文件明细 · 按项目清理' : 'Paths · files · per project'}</span>
              </button>

              {storageAdvancedOpen && (
                <div className="storage-advanced-body">
                  {/* 数据路径 */}
                  <div className="sa-block">
                    <h4 className="sa-block-title">{zh ? '数据路径' : 'Data paths'}</h4>
                    {[
                      { label: zh ? '主配置' : 'Config', path: storageInfo.neoxHomeDir || storageInfo.configDir },
                      { label: zh ? '日志' : 'Logs', path: (storageInfo.neoxHomeDir || storageInfo.configDir) + '/logs' },
                      { label: zh ? '数据库' : 'Database', path: storageInfo.configDir },
                      { label: zh ? '回退快照' : 'Checkpoints', path: '.cdundo/' },
                    ].map(item => (
                      <div key={item.label} className="sa-path-row">
                        <span className="sa-path-label">{item.label}</span>
                        <span className="sa-path-value mono-path">{item.path}</span>
                        {!item.path.startsWith('.') && (
                          <button className="sf-action" style={{ opacity: 1 }} onClick={() => openInFinder(item.path)}
                            title={revealInFileManagerLabel(zh)}>
                            <Icons.ExternalLink />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* 文件明细 */}
                  <div className="sa-block">
                    <h4 className="sa-block-title">{zh ? '文件明细' : 'Files'}</h4>
                    <div className="storage-file-table">
                      {storageInfo.files.map(file => (
                        <div key={file.path} className="storage-file-row">
                          <span className="sf-icon">
                            {file.type === 'directory' ? (
                              expandedDirs.has(file.path) ? <Icons.FolderOpen /> : <Icons.Folder />
                            ) : (
                              <Icons.File />
                            )}
                          </span>
                          <div className="sf-info"
                            onClick={() => file.type === 'directory' ? toggleDir(file.path) : previewConfigFile(file.path, file.name)}
                            style={{ cursor: 'pointer' }}
                          >
                            <span className="sf-name">{file.name}</span>
                            {file.description && <span className="sf-desc">{file.description}</span>}
                          </div>
                          <span className="sf-size">{formatSize(file.size)}</span>
                          <button className="sf-action" onClick={(e) => { e.stopPropagation(); openInFinder(file.path); }}
                            title={revealInFileManagerLabel(zh)}>
                            <Icons.ExternalLink />
                          </button>

                          {file.type === 'directory' && expandedDirs.has(file.path) && dirContents[file.path] && (
                            <div className="sf-children">
                              {dirContents[file.path].length === 0 ? (
                                <div className="sf-empty">{t.common.emptyDir}</div>
                              ) : (
                                dirContents[file.path].map(subFile => (
                                  <div key={subFile.path} className="sf-child-row"
                                    onClick={() => subFile.type === 'json' ? previewConfigFile(subFile.path, subFile.name) : openInFinder(subFile.path)}
                                  >
                                    <span className="sf-icon-sm">
                                      {subFile.type === 'directory' ? <Icons.Folder /> : <Icons.File />}
                                    </span>
                                    <span className="sf-child-name">{subFile.name}</span>
                                    <span className="sf-size">{formatSize(subFile.size)}</span>
                                  </div>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 逐项回退数据 */}
                  {storageInfo.checkpoints.length > 0 && (
                    <div className="sa-block">
                      <h4 className="sa-block-title">{zh ? '代码回退（按项目）' : 'Rollback by project'}</h4>
                      {storageInfo.checkpoints.map(cp => (
                        <div key={cp.workspacePath} className="sa-path-row">
                          <div className="sa-cp-info">
                            <span className="sa-path-label">{cp.workspaceName}</span>
                            <span className="sa-path-value mono-path">{cp.workspacePath}</span>
                          </div>
                          <span className="storage-size-value">{formatSize(cp.size)}</span>
                          <button className="rc-disconnect"
                            onClick={() => handleClearCheckpoint(cp.workspacePath, cp.workspaceName)}
                            title={zh ? '清理' : 'Clear'}>
                            <Icons.Trash />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="remote-empty-clients">
            <span>{t.settings.storage.loadError}</span>
          </div>
        )}
      </div>
    </div>

    {/* Preview modal - rendered at top level so it overlays the settings panel */}
    {renderPreviewModal()}
    </>
  );
};

export default StorageTab;
