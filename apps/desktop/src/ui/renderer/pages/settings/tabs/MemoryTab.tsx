import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import { useAgentModeVariant } from '../../../hooks/useAgentModeVariant';
import Icons from '../../../components/Icons';
import { confirmAsync } from '../../../components/confirmEvents';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';
import {
  PageTitle, Section, SectionTitle, SettingsCard, SettingsRow, SwitchRow, NeoxButton,
} from '../../../components/settings-base';
import { stripRuntimeInjectedMarkers } from '../../../../shared/runtimeInjectedMarkers';
import { MemoryScanImport } from './MemoryScanImport';
import './MemoryTab.css';


type Entry = {
  id: string;
  type: 'shortTerm' | 'session' | 'longTerm' | 'pinned';
  category?: 'pinned' | 'standard' | 'lesson' | 'progress';
  content: string;
  timestamp: number;
};

/** 列表卡默认只露前几条, 其余藏在「展开其余 N 条」后面 */
const PREVIEW_ROWS = 5;

/** 「User: 做个表 -> Completed (tools 3, files 2)」→ 用户那句话 + 结果 */
function parseSession(content: string): { text: string; failed: boolean; tools: number; files: number } {
  const clean = stripRuntimeInjectedMarkers(content).trim();
  const m = /^(?:User:\s*)?([\s\S]*?)\s*->\s*(Completed|Failed)([\s\S]*)$/.exec(clean);
  if (!m) return { text: clean.replace(/^User:\s*/, ''), failed: false, tools: 0, files: 0 };
  const rest = m[3] ?? '';
  return {
    text: m[1],
    failed: m[2] === 'Failed',
    tools: Number(/tools (\d+)/.exec(rest)?.[1] ?? 0),
    files: Number(/files (\d+)/.exec(rest)?.[1] ?? 0),
  };
}

function formatWhen(ts: number, zh: boolean): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return zh ? `今天 ${hm}` : `Today ${hm}`;
  return zh ? `${d.getMonth() + 1}月${d.getDate()}日` : d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

const CATEGORY_LABEL: Record<string, [string, string]> = {
  pinned: ['固定', 'Pinned'],
  standard: ['约定', 'Convention'],
  lesson: ['经验', 'Lesson'],
  progress: ['进度', 'Progress'],
};

function splitMemory(raw: string): { title: string; body: string } {
  const lines = raw.split('\n').map((l) => l.replace(/^#{1,6}\s+/, '').trimEnd()).filter((l) => l.trim());
  const heading = /^#{1,6}\s/.test(raw);
  return heading ? { title: lines[0] ?? '', body: lines.slice(1).join('\n') } : { title: '', body: lines.join('\n') };
}

/* 线条图标 (16px, 1.5 粗细) —— 「怎么记」三行左边 28px 软方块里放, 删除按钮也用这套 */
const LineIcon: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const IconSpark = () => <LineIcon><circle cx="8" cy="8" r="5.5" /><path d="M8 5.2v5.6M5.2 8h5.6" /></LineIcon>;
const IconImport = () => <LineIcon><path d="M8 2.5v7.5M5 7.2l3 3 3-3" /><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" /></LineIcon>;
const IconDoc = () => <LineIcon><rect x="3.5" y="2.5" width="9" height="11" rx="1.5" /><path d="M6 6h4M6 8.5h4M6 11h2.5" /></LineIcon>;
const IconTrash = () => <LineIcon><path d="M3 4.5h10M6.5 4.5V3h3v1.5" /><path d="M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2" /></LineIcon>;

const MemoryItem: React.FC<{ entry: Entry; zh: boolean; onDelete: (e: Entry) => void }> = ({ entry, zh, onDelete }) => {
  const [open, setOpen] = useState(false);
  const { title, body } = splitMemory(stripRuntimeInjectedMarkers(entry.content).trim());
  /* 列表默认一条一行: 有标题只露标题, 正文点「展开」才出来; 没标题的正文夹到两行 */
  const long = title ? !!body : body.length > 120 || body.split('\n').length > 2;
  const label = CATEGORY_LABEL[entry.category ?? (entry.type === 'pinned' ? 'pinned' : 'standard')];
  return (
    <li className="nx-mem-item">
      {/* 类型小标签: 中性淡底, 不分色 */}
      <span className={`nx-mem-tag is-${entry.category ?? 'standard'}`}>{zh ? label[0] : label[1]}</span>
      <div className="nx-mem-body">
        {title && (body ? (
          <button type="button" className={`nx-mem-title is-toggle${open ? ' is-open' : ''}`} onClick={() => setOpen((v) => !v)}>
            {title}<Icons.ChevronDown />
          </button>
        ) : <div className="nx-mem-title">{title}</div>)}
        {body && (!title || open) && <div className={`nx-mem-text${title ? ' is-sub' : ''}${open || !long ? '' : ' is-clamped'}`}>{body}</div>}
        {long && !title && (
          <button type="button" className="nx-mem-more" onClick={() => setOpen((v) => !v)}>
            {open ? (zh ? '收起' : 'Less') : (zh ? '展开' : 'More')}
          </button>
        )}
      </div>
      <span className="nx-mem-when">{formatWhen(entry.timestamp, zh)}</span>
      {/* 删除: 悬停这一行才出现 (CSS 控制) */}
      <button
        type="button"
        className="nx-mem-del"
        title={zh ? '删掉这条' : 'Delete'}
        aria-label={zh ? '删掉这条' : 'Delete'}
        onClick={() => onDelete(entry)}
      >
        <Icons.Close />
      </button>
    </li>
  );
};

/* 最近做过的事: 只显示用户那句话 + 结果, 没有类型标签 */
const SessionItem: React.FC<{ entry: Entry; zh: boolean; onDelete: (e: Entry) => void }> = ({ entry, zh, onDelete }) => {
  const p = parseSession(entry.content);
  /* 纯聊天那种「完成」一个词单独占一行是噪音: 只有动过手或失败了才写这一行 */
  const meta = p.failed || p.tools > 0 ? [
    p.failed ? (zh ? '没做完' : 'Failed') : (zh ? '完成' : 'Done'),
    p.tools > 0 ? (zh ? `${p.tools} 步` : `${p.tools} steps`) : '',
    p.files > 0 ? (zh ? `改了 ${p.files} 个文件` : `${p.files} files`) : '',
  ].filter(Boolean).join(' · ') : '';
  return (
    <li className="nx-mem-item nx-mem-item--session">
      <div className="nx-mem-body">
        <div className="nx-mem-text is-oneline" title={p.text}>{p.text}</div>
        {meta && <div className={`nx-mem-meta${p.failed ? ' is-failed' : ''}`}>{meta}</div>}
      </div>
      <span className="nx-mem-when">{formatWhen(entry.timestamp, zh)}</span>
      <button
        type="button"
        className="nx-mem-del"
        title={zh ? '删掉这条' : 'Delete'}
        aria-label={zh ? '删掉这条' : 'Delete'}
        onClick={() => onDelete(entry)}
      >
        <Icons.Close />
      </button>
    </li>
  );
};

const MemoryTab: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const { isWork } = useAgentModeVariant();
  const {
    memoryConfig,
    handleMemoryConfigChange,
    loadMemoryPreview,
    loadMemoryStats,
    showMemoryPreview,
    setShowMemoryPreview,
    memoryPreview,
  } = useSettingsContext();

  const [memories, setMemories] = useState<Entry[] | null>(null);
  const [sessions, setSessions] = useState<Entry[]>([]);
  /* 首页只有两种: 主页 / 导入 (导入是独立流程, 整页换) */
  const [view, setView] = useState<'home' | 'import'>('home');
  /* 段控件: 同一张列表卡切「记住的事」和「最近做过的事」 */
  const [tab, setTab] = useState<'remembered' | 'recent'>('remembered');
  const [showAll, setShowAll] = useState(false);

  /* 两份分开拉: 混在一个 limit=50 的时间序列表里, 会话摘要一多, 更早的真记忆就被挤出去了 */
  const reload = useCallback(async () => {
    const browse = window.neox.memoryBrowse;
    if (!browse) { setMemories([]); return; }
    try {
      const [pinned, longTerm, session] = await Promise.all([
        browse({ type: 'pinned', limit: 100 }),
        browse({ type: 'longTerm', limit: 100 }),
        browse({ type: 'session', limit: 40 }),
      ]);
      const mem = [...(pinned ?? []), ...(longTerm ?? [])] as Entry[];
      /* 固定的排最前, 其余按时间新的在上 */
      mem.sort((a, b) => (a.type === 'pinned' ? 0 : 1) - (b.type === 'pinned' ? 0 : 1) || b.timestamp - a.timestamp);
      setMemories(mem);
      setSessions(((session ?? []) as Entry[]).filter((s) => parseSession(s.content).text));
    } catch (error) {
      console.error('Failed to load memory:', error);
      setMemories([]);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  /* 自动记忆的判定走 Jev: 开关开着 + 存了 key 才算真生效 (跟实验性功能页 JevCard 同一口径) */
  const [jevLive, setJevLive] = useState(false);
  useEffect(() => {
    window.neox.experimentalGetConfig?.()
      .then((c) => setJevLive(c?.jevEnabled === true && !!c?.jevKeyHint))
      .catch(() => { /* 读不到就按没开显示 */ });
  }, []);

  /* Esc 关预览 —— 跟点遮罩同语义 */
  useEffect(() => {
    if (!showMemoryPreview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowMemoryPreview(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showMemoryPreview, setShowMemoryPreview]);

  const onDelete = useCallback(async (entry: Entry) => {
    const result = await window.neox.memoryDelete?.(entry.id);
    if (result?.success) {
      setMemories((list) => list?.filter((m) => m.id !== entry.id) ?? list);
      setSessions((list) => list.filter((m) => m.id !== entry.id));
      loadMemoryStats();
    } else {
      dispatchOpFailed({ op: zh ? '删除记忆' : 'Delete memory', message: result?.error || (zh ? '没删掉' : 'Not deleted') });
    }
  }, [loadMemoryStats, zh]);

  const clearAll = useCallback(async () => {
    const ok = await confirmAsync({
      title: zh ? '清空记忆' : 'Clear memory',
      variant: 'danger',
      message: zh
        ? '记住的事和最近做过的事会一起清掉，不可撤销。'
        : 'Everything remembered and all recent-work summaries are removed. This cannot be undone.',
      confirmLabel: zh ? '清空' : 'Clear',
    });
    if (!ok) return;
    const result = await window.neox.memoryClear?.('all');
    if (result?.success) {
      await reload();
      loadMemoryStats();
      dispatchHint(zh ? '记忆已清空' : 'Memory cleared', 'info');
    } else {
      dispatchOpFailed({ op: zh ? '清空记忆' : 'Clear memory', message: result?.error || (zh ? '未知错误' : 'Unknown error') });
    }
  }, [reload, loadMemoryStats, zh]);

  /* 加载完且两份都空 —— 页头换成"还没记住"的文案, 清空按钮不出 */
  const pageEmpty = memories !== null && memories.length === 0 && sessions.length === 0;

  if (view === 'import') {
    return (
      <div className="settings-panel-content nx-mem-page">
        <div className="nx-mem-subhead">
          <PageTitle title={zh ? '导入记忆' : 'Import memory'} />
          <NeoxButton variant="ghost" size="sm" onClick={() => setView('home')} leading={<Icons.ChevronLeft />}>
            {zh ? '返回' : 'Back'}
          </NeoxButton>
        </div>
        <Section>
          <MemoryScanImport
            zh={zh}
            onImported={() => { void reload(); loadMemoryStats(); }}
            onShowImported={() => { setTab('remembered'); setShowAll(false); setView('home'); }}
          />
        </Section>
      </div>
    );
  }

  const loaded = memories !== null;
  const autoOn = memoryConfig.autoMemoryEnabled;
  const list: Entry[] = tab === 'remembered' ? (memories ?? []) : sessions;
  const shownList = showAll ? list : list.slice(0, PREVIEW_ROWS);
  const hiddenCount = list.length - shownList.length;
  const segments: Array<{ key: 'remembered' | 'recent'; title: string; count: number }> = [
    { key: 'remembered', title: zh ? '记住的事' : 'Remembered', count: memories?.length ?? 0 },
    { key: 'recent', title: zh ? '最近做过的事' : 'Recent work', count: sessions.length },
  ];

  /* 列表卡的内容: 加载中 / 空态 / 行 + 展开。空态文案沿用原来的 */
  const renderCardBody = () => {
    if (tab === 'remembered') {
      if (memories === null) return <div className="nx-mem-empty neox-text-shimmer">{zh ? '加载中…' : 'Loading…'}</div>;
      if (memories.length === 0) {
        return (
          <div className="nx-mem-empty">
            <Icons.Brain />
            <div>
              <strong>{zh ? '还没有记住任何东西' : 'Nothing remembered yet'}</strong>
              <span>{zh ? '对它说「记住：……」，或定下一个以后都照做的约定，就会出现在这里。' : 'Say "remember: …" or agree on a lasting convention and it shows up here.'}</span>
            </div>
          </div>
        );
      }
    } else if (sessions.length === 0) {
      return <div className="nx-mem-empty nx-mem-empty--quiet">{zh ? '还没有' : 'Nothing yet'}</div>;
    }
    return (
      <>
        <ul className="nx-mem-list">
          {shownList.map((m) => (tab === 'remembered'
            ? <MemoryItem key={m.id} entry={m} zh={zh} onDelete={onDelete} />
            : <SessionItem key={m.id} entry={m} zh={zh} onDelete={onDelete} />))}
        </ul>
        {hiddenCount > 0 && (
          <button type="button" className="nx-mem-expand" onClick={() => setShowAll(true)}>
            <Icons.ChevronDown />
            {zh ? `展开其余 ${hiddenCount} 条` : `Show ${hiddenCount} more`}
          </button>
        )}
      </>
    );
  };

  return (
    <div className="settings-panel-content nx-mem-page">
      <PageTitle
        title={zh ? '记忆' : 'Memory'}
        subtitle={zh ? 'Neox 记得什么 · 每个项目各记各的' : 'What Neox remembers · per project'}
      />

      {/* 段控件: 选中项是白色浮起的小块, 不用实心蓝 */}
      <Section>
        <div className="nx-mem-seg" role="tablist">
          {segments.map((s) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={tab === s.key}
              className={`nx-mem-seg__btn${tab === s.key ? ' is-on' : ''}`}
              onClick={() => { setTab(s.key); setShowAll(false); }}
            >
              {s.title}
              <span className="nx-mem-seg__count">· {loaded ? s.count : '…'}</span>
            </button>
          ))}
        </div>
        <p className="nx-mem-subdesc">
          {tab === 'remembered'
            ? (zh ? '你让它记住的事、定下的约定、踩过的坑 · 记错了就删掉' : 'Things you asked it to remember, conventions, lessons · delete anything that is wrong')
            : (zh ? '新会话会参考这些，接着上次的活干 · 没用的可以删掉' : 'New sessions look at these to pick up where you left off')}
        </p>
        {pageEmpty && (
          <p className="set-note set-note--above">
            {zh ? '还没记住任何东西。对它说「记住：……」，就会出现在这里。每个项目各记各的。' : 'Nothing remembered yet. Say “remember: …” and it shows up here. Each project keeps its own.'}
          </p>
        )}
        {/* 一张列表卡: 圆角 16, 发丝边, 行间细分隔线 */}
        <div className="nx-mem-card">
          {renderCardBody()}
        </div>
      </Section>

      <Section>
        <SectionTitle title={zh ? '怎么记' : 'How it remembers'} />
        <SettingsCard>
          <SwitchRow
            leading={<span className="mem-ico"><IconSpark /></span>}
            title={zh ? '自动记忆' : 'Auto memory'}
            desc={jevLive
              ? (zh ? '每轮结束判断一次，值得记的自动记下。Jev 加持已开。' : 'After each turn, anything worth keeping is saved. Jev boost is on.')
              : (
                <>
                  {zh ? '要开 Jev 加持才生效；没开时只在 Agent 主动写入时记。' : 'Needs Jev boost; otherwise only when the agent writes on purpose.'}
                  {' '}
                  <button type="button" className="mfs-link"
                    onClick={() => window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab: 'experimental' } }))}>
                    {zh ? '去开 Jev' : 'Set up Jev'}
                  </button>
                </>
              )}
            checked={autoOn}
            onChange={(v) => handleMemoryConfigChange('autoMemoryEnabled', v)}
          />
          <SettingsRow
            leading={<span className="mem-ico"><IconImport /></span>}
            title={zh ? '从 Claude Code / Codex / Hermes 导入' : 'Import from Claude Code / Codex / Hermes'}
            desc={zh ? '把它们记下的约定和经验搬过来。' : 'Bring over the conventions and lessons they kept.'}
            control={(
              <button type="button" className="nx-mem-pill" onClick={() => setView('import')}>
                {zh ? '导入' : 'Import'}
              </button>
            )}
          />
          <SettingsRow
            leading={<span className="mem-ico"><IconDoc /></span>}
            title={zh ? '每轮带给模型的原文' : 'What the model receives'}
            control={(
              <button type="button" className="nx-mem-pill" onClick={loadMemoryPreview}>
                {zh ? '预览' : 'Preview'}
              </button>
            )}
          />
        </SettingsCard>
      </Section>

      {/* 页脚: 浅红底整宽行, 清空仍走原来的确认弹窗 */}
      {!isWork && !pageEmpty && (
        <div className="mem-foot">
          <button type="button" className="mem-foot__clear" onClick={clearAll}>
            <IconTrash />
            {zh ? '清空这个项目的记忆' : 'Clear this project’s memory'}
          </button>
        </div>
      )}

      {showMemoryPreview && (
        <div className="modal-overlay" onClick={() => setShowMemoryPreview(false)}>
          <div className="modal-content memory-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{zh ? '记忆注入预览' : 'Memory Injection Preview'}</h3>
              <button className="modal-close" onClick={() => setShowMemoryPreview(false)} title={zh ? '关闭' : 'Close'} aria-label={zh ? '关闭' : 'Close'}>
                <Icons.Close />
              </button>
            </div>
            <div className="modal-body">
              <pre className="memory-preview-content">
                {memoryPreview || (zh ? '(无可用记忆)' : '(No memory available)')}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MemoryTab;
