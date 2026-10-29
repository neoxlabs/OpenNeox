import React from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import { PageTitle, NeoxButton, Section, SectionTitle, SettingsCard, SettingsRow, RowIcon } from '../../../components/settings-base';
import { NeoxIllus } from '../../../media/illus';
import './CodeIndexTab.clay.css';

const CodeIndexTab: React.FC = () => {
  const {
    indexLoading,
    indexStats,
    indexBuilding,
    indexBuildProgress,
    handleBuildIndex,
    handleClearIndex,
    setShowIndexExcludeConfig,
  } = useSettingsContext();
  const { language } = useI18n();
  const zh = language === 'zh';

  const hasIndex = !!indexStats?.hasIndex;
  const pct = indexBuildProgress && indexBuildProgress.total > 0
    ? Math.round((indexBuildProgress.current / indexBuildProgress.total) * 100)
    : 0;
  const fmt = (n: number) => n.toLocaleString(zh ? 'zh-CN' : 'en');
  const updated = hasIndex && indexStats!.lastUpdated ? relTime(new Date(indexStats!.lastUpdated).getTime(), zh) : null;

  const status = indexLoading ? (zh ? '读取中' : 'Loading')
    : indexBuilding ? (zh ? '构建中' : 'Building')
    : hasIndex ? (zh ? '已就绪' : 'Ready') : (zh ? '还没建' : 'Not built');

  return (
    <div className="settings-panel-content ci3">
      <PageTitle
        title={zh ? '代码索引' : 'Code index'}
        subtitle={zh ? '找函数、查引用直接走索引' : 'Find functions and references straight from the index'}
      />

      <Section>
        <SettingsCard>
          <SettingsRow
            leading={<RowIcon src={NeoxIllus.codeHero} />}
            title={(
              <span className="ci-status">
                {zh ? '这个项目的索引' : 'Index for this project'}
                <span className={`ci-pill${hasIndex ? ' is-ok' : ''}`}>{status}</span>
                {updated && !indexBuilding && <span className="ci-status__when">{zh ? `${updated}更新` : `Updated ${updated}`}</span>}
              </span>
            )}
            desc={indexBuilding ? (
              <span className="ci-build">
                <span className="ci-build__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <span className="ci-build__fill" style={{ width: `${indexBuildProgress ? pct : 12}%` }} />
                </span>
                <span>{indexBuildProgress ? `${fmt(indexBuildProgress.current)} / ${fmt(indexBuildProgress.total)}` : (zh ? '扫描文件…' : 'Scanning…')}</span>
              </span>
            ) : hasIndex
              ? (zh
                ? `${fmt(indexStats!.fileCount)} 个文件 · ${fmt(indexStats!.symbolCount)} 个符号 · ${(indexStats!.size / 1024).toFixed(0)} KB。改过代码后点更新。`
                : `${fmt(indexStats!.fileCount)} files · ${fmt(indexStats!.symbolCount)} symbols · ${(indexStats!.size / 1024).toFixed(0)} KB. Update after code changes.`)
              : (zh ? '建好后找函数、查引用直接走索引；没建时 Agent 只能挨个读文件找。' : 'Lets the agent find symbols and references directly; without it, it reads files one by one.')}
            control={(
              <NeoxButton size="sm" onClick={() => handleBuildIndex(false)} disabled={indexBuilding}>
                {indexBuilding ? (zh ? '构建中…' : 'Building…') : hasIndex ? (zh ? '更新' : 'Update') : (zh ? '构建索引' : 'Build index')}
              </NeoxButton>
            )}
          />
        </SettingsCard>
      </Section>

      <Section>
        <SectionTitle title={zh ? '维护' : 'Maintenance'} />
        <SettingsCard>
          <SettingsRow
            leading={<RowIcon src={NeoxIllus.codeExclude} />}
            title={zh ? '排除规则' : 'Exclude rules'}
            desc={zh ? 'node_modules、构建产物等不进索引。' : 'Keep node_modules, build output and the like out.'}
            control={<NeoxButton size="sm" onClick={() => setShowIndexExcludeConfig(true)}>{zh ? '配置' : 'Configure'}</NeoxButton>}
          />
          <SettingsRow
            leading={<RowIcon src={NeoxIllus.codeRebuild} />}
            title={zh ? '从头重建' : 'Rebuild'}
            desc={zh ? '结果不对时，丢掉旧索引重扫。' : 'Results look off? Start over from scratch.'}
            control={<NeoxButton size="sm" onClick={() => handleBuildIndex(true)} disabled={indexBuilding}>{zh ? '重建' : 'Rebuild'}</NeoxButton>}
          />
          <SettingsRow
            leading={<RowIcon src={NeoxIllus.storeClean} />}
            title={zh ? '清除索引' : 'Clear index'}
            desc={zh ? '删掉本地索引文件。' : 'Deletes the local index files.'}
            control={<NeoxButton variant="danger" size="sm" onClick={handleClearIndex} disabled={!hasIndex || indexBuilding}>{zh ? '清除' : 'Clear'}</NeoxButton>}
          />
        </SettingsCard>
      </Section>
    </div>
  );
};

function relTime(ms: number, zh: boolean): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (zh) {
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default CodeIndexTab;
