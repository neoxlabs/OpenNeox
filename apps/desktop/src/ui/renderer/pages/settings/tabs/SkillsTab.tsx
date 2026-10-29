import './SkillsTab.css';
import React from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import { CustomSelect } from '../../../components/CustomSelect';
import { PageTitle, NeoxButton, EmptyState, Segmented } from '../../../components/settings-base';
import { SkillEditForm } from './SkillEditForm';
import { SkillDetailView } from './SkillDetailView';
import { AutomationsSection } from './AutomationsSection';
import { NeoxIllus } from '../../../media/illus';

// ==================== Skills 类型 (mirrored from SettingsPage) ====================
type SkillCategory = 'git' | 'code' | 'test' | 'docs' | 'refactor' | 'debug' | 'deploy' | 'custom';
type SkillSource = 'builtin' | 'user' | 'workspace' | 'mcp';

interface SkillInfo {
  id: string;
  path: string;
  source: SkillSource;
  metadata: {
    name: string;
    description: string;
    /** 英文描述 —— 内置技能的 SKILL.md 里都带这个字段。类型里漏了它,
     *  于是设置页只能渲染中文那份 (英文界面下技能描述全中文)。 */
    description_en?: string;
    'user-invocable'?: boolean;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
    paths?: string[];
    whenToUse?: string;
    version?: string;
    disableModelInvocation?: boolean;
    neox?: {
      category?: SkillCategory;
      aliases?: string[];
      dangerLevel?: 'safe' | 'moderate' | 'dangerous';
      allowedTools?: string[];
      arguments?: Array<{
        name: string;
        description: string;
        required?: boolean;
      }>;
    };
  };
  content: string;
  contentLength?: number;
}

/** 调用记录的一条 (与 SettingsPage 里 skillExecutionHistory 同形) */
interface SkillHistoryRow {
  id: string;
  skillId: string;
  timestamp: number;
  status: 'success' | 'error';
  duration: number;
  args?: string;
}

/** 「3 天前」这种相对时间; 超过一个月直接给日期 */
function relativeTime(ts: number, zh: boolean): string {
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  if (sec < 60) return zh ? '刚刚' : 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return zh ? `${min} 分钟前` : `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return zh ? `${hour} 小时前` : `${hour}h ago`;
  const day = Math.floor(hour / 24);
  if (day < 30) return zh ? `${day} 天前` : `${day}d ago`;
  return new Date(ts).toLocaleDateString(zh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' });
}

/**
 * SkillsTab - renders skill management.
 * Extracted from SettingsPage.renderSkillsContent.
 */
/* 每组每页多少张卡。24 = 两列 × 12 行, 一屏滚一下到底; 再多就该翻页而不是滚。 */
const SKILLS_PAGE_SIZE = 24;

const SkillsTab: React.FC = () => {
  const [importableCount, setImportableCount] = React.useState<number | null>(null);
  React.useEffect(() => {
    let alive = true;
    const api = (window as any).neox;
    if (typeof api?.skillsDiscoverExternal !== 'function') return;
    void api.skillsDiscoverExternal()
      .then((list: Array<{ alreadyImported?: boolean }> | null) => {
        if (!alive || !Array.isArray(list)) return;
        setImportableCount(list.filter((x) => !x?.alreadyImported).length);
      })
      .catch(() => { /* 扫不动就当没有 */ });
    return () => { alive = false; };
  }, []);

  /* 调用记录: 卡片右下角「用过 N 次」要用。进页面就拉一次 (同一个 IPC 调用记录弹窗也用),
   * 打开弹窗时再拉一次刷新。拉不到就当没有记录, 卡片上不显示这一行。 */
  const [historyRows, setHistoryRows] = React.useState<SkillHistoryRow[]>([]);
  React.useEffect(() => {
    let alive = true;
    const api = (window as any).neox;
    if (typeof api?.skillsGetHistory !== 'function') return;
    void api.skillsGetHistory()
      .then((list: unknown) => { if (alive && Array.isArray(list)) setHistoryRows(list as SkillHistoryRow[]); })
      .catch(() => { /* 拉不到就当没有调用记录 */ });
    return () => { alive = false; };
  }, []);
  /* 按技能 id 汇总: 次数 + 最近一次时间 */
  const usageBySkill = React.useMemo(() => {
    const m = new Map<string, { count: number; last: number }>();
    for (const r of historyRows) {
      const cur = m.get(r.skillId) ?? { count: 0, last: 0 };
      cur.count += 1;
      cur.last = Math.max(cur.last, r.timestamp);
      m.set(r.skillId, cur);
    }
    return m;
  }, [historyRows]);

  /* 三组各自的页码 (见下面 renderGroup 的说明) */
  const [groupPage, setGroupPage] = React.useState<{ builtin?: number; mine?: number; installed?: number }>({});
  /* 搜索 —— 上百个技能时, 翻页找不如直接搜 */
  const [query, setQuery] = React.useState('');
  const { language } = useI18n();
  const ctx = useSettingsContext();
  if (ctx.viewingSkill) {
    return <SkillDetailView />;
  }
  if (ctx.showSkillAddForm || ctx.showSkillImportForm) {
    return <SkillEditForm />;
  }
  const {
    setSkillExecutionHistory,
    setShowSkillHistory,
    setShowSkillImportForm,
    resetSkillForm,
    setShowSkillAddForm,
    skillFilterSource,
    setSkillFilterSource,
    skillFilterCategory,
    setSkillFilterCategory,
    loadSkills,
    skillsLoading,
    filteredSkills,
    installedMetas,
    handleSkillView,
    handleSkillEdit,
    handleSkillExport,
    handleSkillDelete,
    handleSkillK4Update,
    handleSkillK4Trust,
    handleSkillK4Untrust,
    handleSkillK4Uninstall,
    skillGroups,
  } = ctx;

  const zh = language === 'zh';
  const openHistory = async () => {
    try {
      const history = await (window as any).neox.skillsGetHistory();
      if (Array.isArray(history)) {
        setSkillExecutionHistory(history);
        setHistoryRows(history as SkillHistoryRow[]);
      }
    } catch (e) {
      console.error('Failed to fetch skill history:', e);
    }
    setShowSkillHistory(true);
  };
  const mineCount = skillGroups.mine.length;
  const installedCount = skillGroups.installed.length;

  return (
    <div className="settings-panel-content skills-panel sk3">
      <PageTitle
        title={zh ? '技能' : 'Skills'}
        subtitle={zh
          ? '把常做的事存成一句命令，输入框敲 / 就能调用，Agent 也会按需自己用'
          : 'Save routine work as one command. Type / in the composer to run it; the agent also uses them when it fits.'}
      />

      {/* 统计卡: 三个数字 (我的 / 商店装的 / 可导入) + 右侧「创建」「导入」药丸按钮。
        * 原页头插画横幅的操作全部收到这里, 「调用记录」挪到列表下面。 */}
      <section className="sk3-stats">
        <div className="sk3-stats__nums">
          <div className="sk3-stat">
            <b>{mineCount}</b>
            <span>{zh ? '个我的' : 'mine'}</span>
          </div>
          <div className="sk3-stat">
            <b>{installedCount}</b>
            <span>{zh ? '个商店装的' : 'from store'}</span>
          </div>
          {importableCount !== null && importableCount > 0 && (
            <button type="button" className="sk3-stat sk3-stat--link" onClick={() => setShowSkillImportForm(true)}>
              <b>{importableCount}</b>
              <span>{zh ? '个可从 Claude Code / Codex 导入 →' : 'importable from Claude Code / Codex →'}</span>
            </button>
          )}
        </div>
        <div className="sk3-stats__actions">
          <button type="button" className="sk3-pill" onClick={() => { resetSkillForm(); setShowSkillAddForm(true); }}>
            <Icons.Plus />{zh ? '创建' : 'Create'}
          </button>
          <button type="button" className="sk3-pill" onClick={() => setShowSkillImportForm(true)}>
            <Icons.Download />{zh ? '导入' : 'Import'}
          </button>
        </div>
      </section>

      {/* 筛选行: 左边来源 + 分类, 右边搜索 (220px)。内置不进这个列表, 所以没有"含内置"的选项 */}
      <div className="sk3-toolbar">
        <div className="sk3-toolbar__left">
          <Segmented
            value={skillFilterSource as 'mine' | 'user' | 'workspace'}
            onChange={(v) => setSkillFilterSource(v as SkillSource | 'all' | 'mine')}
            options={[
              { value: 'mine', label: zh ? '全部' : 'All' },
              { value: 'user', label: zh ? '所有项目' : 'All projects' },
              { value: 'workspace', label: zh ? '仅当前项目' : 'This project only' },
            ]}
          />
          <div style={{ minWidth: 128 }}>
            <CustomSelect
              value={skillFilterCategory}
              onChange={(v) => setSkillFilterCategory(v as SkillCategory | 'all')}
              options={[
                { value: 'all', label: zh ? '所有分类' : 'All categories' },
                { value: 'git', label: 'Git' },
                { value: 'code', label: 'Code' },
                { value: 'test', label: 'Test' },
                { value: 'docs', label: 'Docs' },
                { value: 'refactor', label: 'Refactor' },
                { value: 'debug', label: 'Debug' },
                { value: 'deploy', label: 'Deploy' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
          </div>
        </div>
        {/* 搜索 —— 上百个技能时翻页不如直接搜。名字 / 命令名 / 描述 三处任一命中即可,
          * 因为用户记住的往往是"那个写小红书的", 而不是它叫什么。 */}
        <div className="sk3-toolbar__search">
          <Icons.Search />
          <input
            className="nx-bare-input"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setGroupPage({}); }}
            placeholder={language === 'zh' ? '搜索技能' : 'Search skills'}
            aria-label={language === 'zh' ? '搜索技能' : 'Search skills'}
          />
          {query && (
            <button
              type="button"
              className="sk3-toolbar__search-clear"
              onClick={() => { setQuery(''); setGroupPage({}); }}
              aria-label={language === 'zh' ? '清空' : 'Clear'}
            >
              <Icons.Close />
            </button>
          )}
        </div>
        <NeoxButton variant="ghost" size="sm" className="sk3-toolbar__refresh" onClick={loadSkills} title={language === 'zh' ? '刷新' : 'Refresh'} aria-label="Refresh">
          <Icons.Refresh />
        </NeoxButton>
      </div>

      <div className="settings-list">
        {/* 技能列表 — A1: 三段分组 (内置 / 我的 / 商店装的) */}
        {skillsLoading ? (
          <div className="loading-state" style={{ padding: '60px 16px', textAlign: 'center' }}>
            <Icons.Loader /><span className="neox-text-shimmer" style={{ marginLeft: 8 }}>{language === 'zh' ? '加载中...' : 'Loading...'}</span>
          </div>
        ) : filteredSkills.length === 0 ? (
          <EmptyState
            icon={<Icons.Sparkles />}
            art={NeoxIllus.skill}
            /* "自己的": 内置技能一直在 (输入框 / 菜单里能用), 这页只是不列它们 —— 说"还没有技能"不对 */
            title={language === 'zh' ? '还没有自己的技能' : 'No skills of your own yet'}
            /* 原文案提"从市场导入" —— 我们没有市场。真实入口是从 Claude Code / Codex 搬,
               或者自己写一个。空态就该指向那两条真路径, 不写没有的东西。 */
            /* 有现成的就报数 —— 「可以导入」和「你有 35 个可以导入」是两句话。 */
            desc={importableCount && importableCount > 0
              ? (language === 'zh'
                ? `检测到 ${importableCount} 个可以从 Claude Code / Codex 直接导入，也可以自己写一个。`
                : `Found ${importableCount} ready to import from Claude Code / Codex — or write your own.`)
              : (language === 'zh' ? '从 Claude Code / Codex 导入，或自己写一个。' : 'Import from Claude Code / Codex, or write your own.')}
            actions={<>
              <NeoxButton size="sm" variant="primary" leading={<Icons.Download />} onClick={() => setShowSkillImportForm(true)}>
                {importableCount && importableCount > 0
                  ? (language === 'zh' ? `导入 ${importableCount} 个技能` : `Import ${importableCount} skills`)
                  : (language === 'zh' ? '导入技能' : 'Import Skill')}
              </NeoxButton>
              <NeoxButton size="sm" variant="secondary" leading={<Icons.Plus />} onClick={() => { resetSkillForm(); setShowSkillAddForm(true); }}>
                {language === 'zh' ? '创建技能' : 'Create Skill'}
              </NeoxButton>
            </>}
          />
        ) : (() => {
          const renderRow = (skill: SkillInfo) => {
            const k4Meta = installedMetas[skill.id];
            const isLimited = k4Meta?.trustLevel === 'limited';
            const isTrusted = k4Meta?.trustLevel === 'trusted';
            const slashInvocable = skill.metadata['user-invocable'] !== false;
            /* 调用次数 + 最近一次 —— 来自调用记录 (historyRows), 没有记录就不显示 */
            const usage = usageBySkill.get(skill.id);
            return (
              <div
                key={skill.id}
                className="sk3-card"
                role="button"
                tabIndex={0}
                onClick={() => handleSkillView(skill)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSkillView(skill); }
                }}
                title={language === 'zh' ? '查看详情' : 'View detail'}
              >
                {/* 第一行: 命令名 (等宽墨色) + 来源小标签; 悬停时右上角才露出操作 */}
                <div className="sk3-card__top">
                  {skill.metadata?.name && skill.metadata.name !== skill.id && /[^\x00-\x7f]/.test(skill.metadata.name)
                    && <span className="sk3-card__name">{skill.metadata.name}</span>}
                  <span className="sk3-card__cmd">{slashInvocable ? `/${skill.id}` : skill.id}</span>
                  {/* 来源说人话: 设计稿三档 我的 / 商店 / 项目; 不能斜杠调的系统技能单独标「系统」。
                    * 悬停提示保留 "不能用斜杠命令调用" 的解释 */}
                  <span
                    className="sk3-chip"
                    title={!slashInvocable
                      ? (language === 'zh' ? '不能用斜杠命令调用, 由对应页面的按钮触发' : 'Not a slash command — triggered from its own page')
                      : undefined}
                  >
                    {!slashInvocable
                      ? (language === 'zh' ? '系统' : 'System')
                      : k4Meta
                        ? (language === 'zh' ? '商店' : 'Store')
                        : skill.source === 'workspace'
                          ? (language === 'zh' ? '项目' : 'Project')
                          : skill.source === 'mcp' ? 'MCP' : (language === 'zh' ? '我的' : 'Mine')}
                  </span>
                </div>
                {/* 描述: 单行 ellipsis。两份描述按语言取, 任一存在即显示; 截断部分靠 title 兜底 */}
                {(() => {
                  const desc = language === 'zh'
                    ? (skill.metadata?.description ?? skill.metadata?.description_en)
                    : (skill.metadata?.description_en ?? skill.metadata?.description);
                  return desc ? <div className="sk3-card__desc" title={desc}>{desc}</div> : null;
                })()}
                {/* 底行: 左边分类 / 版本 / 信任状态 (小字); 右边「用过 N 次 · X 前」—— 只有有调用记录才出 */}
                <div className="sk3-card__foot">
                  <span className="sk3-card__meta">
                    {/* custom 是"没分类"的默认值, 每张卡都挂一枚 CUSTOM 只是噪音 */}
                    {skill.metadata?.neox?.category && skill.metadata.neox.category !== 'custom' && (
                      <span>{skill.metadata?.neox.category}</span>
                    )}
                    {k4Meta?.installedVersion && k4Meta.installedVersion !== 'unknown' && (
                      <span>v{k4Meta.installedVersion}</span>
                    )}
                    {k4Meta && (
                      <span
                        className={`sk3-card__tag ${isLimited ? 'is-limited' : 'is-trusted'}`}
                        title={isLimited
                          ? (language === 'zh' ? '只能调用它自己声明的工具' : 'Can only call the tools it declares')
                          : (language === 'zh' ? '可以调用任意工具' : 'Can call any tool')}
                      >
                        {isLimited
                          ? (language === 'zh' ? '受限' : 'limited')
                          : (language === 'zh' ? '不受限' : 'trusted')}
                      </span>
                    )}
                  </span>
                  {usage && (
                    <span className="sk3-card__usage">
                      {language === 'zh'
                        ? `用过 ${usage.count} 次 · ${relativeTime(usage.last, true)}`
                        : `Used ${usage.count}× · ${relativeTime(usage.last, false)}`}
                    </span>
                  )}
                </div>
                <div className="sk3-card__acts" onClick={(e) => e.stopPropagation()}>
                  {skill.source !== 'builtin' && (
                    <button
                      className="skill-action-btn edit"
                      onClick={() => handleSkillEdit(skill)}
                      title={language === 'zh' ? '编辑' : 'Edit'}
                    >
                      <Icons.Edit />
                    </button>
                  )}
                  <button
                    className="skill-action-btn export"
                    onClick={() => handleSkillExport(skill)}
                    title={language === 'zh' ? '导出' : 'Export'}
                  >
                    <Icons.Export />
                  </button>
                  {skill.source !== 'builtin' && !k4Meta && (
                    <button
                      className="skill-action-btn delete"
                      onClick={() => handleSkillDelete(skill.id, skill.source)}
                      title={language === 'zh' ? '删除' : 'Delete'}
                    >
                      <Icons.Delete />
                    </button>
                  )}
                  {k4Meta && (
                    <>
                      {k4Meta.source?.url && (
                        <button
                          className="skill-action-btn update"
                          onClick={() => handleSkillK4Update(skill.id)}
                          title={language === 'zh' ? '检查更新' : 'Check for update'}
                        >
                          <Icons.Refresh />
                        </button>
                      )}
                      {isLimited && (
                        <button
                          className="skill-action-btn trust"
                          onClick={() => handleSkillK4Trust(skill.id)}
                          title={language === 'zh' ? '信任 (允许调任意工具)' : 'Trust (allow any tool)'}
                        >
                          <Icons.Check />
                        </button>
                      )}
                      {isTrusted && (
                        <button
                          className="skill-action-btn untrust"
                          onClick={() => handleSkillK4Untrust(skill.id)}
                          title={language === 'zh' ? '撤销信任' : 'Untrust'}
                        >
                          <Icons.Close />
                        </button>
                      )}
                      <button
                        className="skill-action-btn delete"
                        onClick={() => handleSkillK4Uninstall(skill.id)}
                        title={language === 'zh' ? '卸载' : 'Uninstall'}
                      >
                        <Icons.Delete width={16} height={16} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          };

          const q = query.trim().toLowerCase();
          const matches = (sk: SkillInfo) => {
            if (!q) return true;
            const desc = String(sk.metadata?.description ?? '') + String((sk.metadata as any)?.description_en ?? '');
            return sk.id.toLowerCase().includes(q)
              || String(sk.metadata?.name ?? '').toLowerCase().includes(q)
              || desc.toLowerCase().includes(q);
          };
          const renderGroup = (key: 'builtin' | 'mine' | 'installed', label: string) => {
            const all = skillGroups[key].filter(matches);
            if (all.length === 0) return null;
            const page = groupPage[key] ?? 0;
            const pages = Math.max(1, Math.ceil(all.length / SKILLS_PAGE_SIZE));
            /* 过滤/切换来源后原页码可能越界 —— 夹回最后一页, 不然会显示空白一页 */
            const cur = Math.min(page, pages - 1);
            const slice = all.slice(cur * SKILLS_PAGE_SIZE, (cur + 1) * SKILLS_PAGE_SIZE);
            return (
              <div className="sk3-group" key={key}>
                <h4 className="sk3-group__title">
                  {label}
                  <span className="sk3-group__count">{all.length}</span>
                </h4>
                <div className="sk3-grid">{slice.map(renderRow)}</div>
                {pages > 1 && (
                  <div className="sk3-pager">
                    <button
                      className="sk3-pager__btn"
                      disabled={cur === 0}
                      onClick={() => setGroupPage((p) => ({ ...p, [key]: cur - 1 }))}
                      aria-label={language === 'zh' ? '上一页' : 'Previous page'}
                    >
                      <Icons.ChevronDown width={16} height={16} style={{ transform: 'rotate(90deg)' }} />
                    </button>
                    <span className="sk3-pager__label">
                      {cur + 1} / {pages}
                    </span>
                    <button
                      className="sk3-pager__btn"
                      disabled={cur >= pages - 1}
                      onClick={() => setGroupPage((p) => ({ ...p, [key]: cur + 1 }))}
                      aria-label={language === 'zh' ? '下一页' : 'Next page'}
                    >
                      <Icons.ChevronDown width={16} height={16} style={{ transform: 'rotate(-90deg)' }} />
                    </button>
                  </div>
                )}
              </div>
            );
          };

          return (
            <>
              {renderGroup('mine', language === 'zh' ? '我的' : 'My Skills')}
              {renderGroup('installed', language === 'zh' ? '商店装的' : 'Installed from Store')}
              {/* 内置分组整个删掉 —— 数据源已经滤掉 builtin, 这里再留一个分支只会误导
                * 下一个人以为"某些情况下会显示"。 */}
            </>
          );
        })()}
      </div>

      {!skillsLoading && <AutomationsSection zh={zh} />}

      {/* 调用记录入口: 列表下面一个安静的钴蓝文字链接 (原在页头, 挪到这里) */}
      {!skillsLoading && (
        <div className="sk3-footer">
          <button type="button" className="sk3-link" onClick={() => void openHistory()}>
            {zh ? '调用记录 →' : 'Invocation history →'}
          </button>
        </div>
      )}
    </div>
  );
};

export default SkillsTab;
