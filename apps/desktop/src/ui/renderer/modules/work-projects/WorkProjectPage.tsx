/**
 * Work 项目主页 (设计稿 E8jf「Work · 项目页」)
 *
 *   64px 陶土图标 + 项目名 + 一行灰字 (工作 / 项目 · N 个任务 · M 个文件) + 打开文件夹
 *   输入框: 从这里发的任务都进这个项目
 *   项目说明 (每个任务都会带上) | 资料 (拖文件进来, 每个任务都能用)
 *   任务列表: 成品缩略图 + 任务名 + 成品文件名和状态 + 时间
 *
 * 说明和资料由主进程写进项目文件夹的 .neox/INSTRUCTIONS.md, runtime 往上找项目指令时自动带上
 * (见 electron/ipc/workProjectHandlers.ts)。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { dispatchHint } from '../../components/notifyEvents';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { displaySessionName } from '../../state/sessionDisplayName';
import { useSessionGlance } from '../shell/useSessionGlance';
import { projectArt, shortDay, tasksByProject, useWorkProjects } from '../shell/workProjects';
import thumbSlides from '../../media/clay/thumb-slides.webp';
import thumbSheet from '../../media/clay/thumb-sheet.webp';
import thumbDoc from '../../media/clay/thumb-doc.webp';
import thumbImage from '../../media/clay/thumb-image.webp';
import './work-projects-page.css';
import { absoluteToAssetUrl } from '../../../shared/assetUrlPath';

interface Material { name: string; path: string; isDir: boolean; count?: number; mtime: number }
interface Profile { audience?: string; tone?: string; template?: string; forbidden?: string }
interface Detail { notes: string; materials: Material[]; fileCount: number; profile?: Profile }

/* 项目口径四项 (work:Q-11): 同一客户第二份材料不用再重说一遍 */
const PROFILE_ROWS: Array<{ key: keyof Profile; zh: string; en: string; phZh: string; phEn: string }> = [
  { key: 'audience', zh: '受众', en: 'Audience', phZh: '给谁看，比如：加盟商和店长', phEn: 'Who reads it' },
  { key: 'tone', zh: '口吻', en: 'Tone', phZh: '什么口吻，比如：务实、不用形容词', phEn: 'Voice, e.g. plain and factual' },
  { key: 'template', zh: '模板', en: 'Template', phZh: '照哪个版式，比如：沿用 2026 春季周报', phEn: 'Which format to follow' },
  { key: 'forbidden', zh: '禁写项', en: 'Never write', phZh: '不能出现的说法，比如：不写「保证」「第一」', phEn: 'Phrases to avoid' },
];

type Api = {
  workProjectDetail?: (dir: string) => Promise<{ ok?: boolean; notes?: string; materials?: Material[]; fileCount?: number; profile?: Profile; error?: string }>;
  workProjectSaveNotes?: (dir: string, notes: string) => Promise<{ ok?: boolean; error?: string }>;
  workProjectSaveProfile?: (dir: string, profile: Profile) => Promise<{ ok?: boolean; profile?: Profile; error?: string }>;
  workProjectAddMaterials?: (dir: string, paths?: string[]) => Promise<{ ok?: boolean; materials?: Material[]; canceled?: boolean; error?: string }>;
  getPathForFile?: (f: File) => string | null;
  surfaceOpenExternal?: (p: string) => Promise<unknown>;
};
const api = (): Api => ((window as { neox?: Api }).neox ?? {});

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const assetUrl = absoluteToAssetUrl;
const artFor = (ext?: string, title = '') => {
  if (ext && /^(pptx?|key)$/.test(ext)) return thumbSlides;
  if (ext && /^(xlsx?|csv|tsv)$/.test(ext)) return thumbSheet;
  if (ext && IMG_EXT.has(ext)) return thumbImage;
  if (ext) return thumbDoc;
  return /ppt|幻灯|课件|演示/i.test(title) ? thumbSlides : /表|excel|数据|统计/i.test(title) ? thumbSheet : /图|海报|设计/i.test(title) ? thumbImage : thumbDoc;
};
const matArt = (m: Material) => m.isDir ? thumbImage : artFor(m.name.split('.').pop()?.toLowerCase());

export const WorkProjectPage: React.FC<{
  dir: string;
  onBack: () => void;
  onOpenSession: (id: string) => void;
  onNewTask: (prompt: string) => void;
  zh: boolean;
}> = ({ dir, onBack, onOpenSession, onNewTask, zh }) => {
  const projects = useWorkProjects();
  const project = projects.find((p) => p.dir === dir);
  const { sessions, runningSessionIds } = useNeoxRuntime();
  const tasks = useMemo(() => tasksByProject(sessions, projects).get(dir) ?? [], [sessions, projects, dir]);
  const glance = useSessionGlance(useMemo(() => tasks.slice(0, 40).map((t) => t.id), [tasks]));
  const [detail, setDetail] = useState<Detail>({ notes: '', materials: [], fileCount: 0 });
  const [profileDraft, setProfileDraft] = useState<Profile>({});
  const [profileSaving, setProfileSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [prompt, setPrompt] = useState('');
  const [dropOver, setDropOver] = useState(false);

  const load = useCallback(async () => {
    const r = await api().workProjectDetail?.(dir).catch(() => null);
    if (r?.ok) {
      setDetail({ notes: r.notes ?? '', materials: r.materials ?? [], fileCount: r.fileCount ?? 0, profile: r.profile });
      setProfileDraft(r.profile ?? {});
    }
  }, [dir]);
  useEffect(() => { void load(); }, [load, tasks.length]);

  const saveNotes = async () => {
    const r = await api().workProjectSaveNotes?.(dir, draft);
    if (!r?.ok) { dispatchHint(r?.error || (zh ? '保存失败' : 'Save failed'), 'warning'); return; }
    setEditing(false);
    void load();
  };
  /* 项目口径 (work:Q-11): 存进项目标记文件, 以后每个任务自动带上 */
  const saveProfile = async () => {
    setProfileSaving(true);
    try {
      const r = await api().workProjectSaveProfile?.(dir, profileDraft);
      if (!r?.ok) { dispatchHint(r?.error || (zh ? '保存失败' : 'Save failed'), 'warning'); return; }
      setProfileDraft(r.profile ?? {});
      dispatchHint(zh ? '项目口径已保存，以后这个项目的任务都按它来' : 'Saved — every task in this project will use it', 'success');
    } finally {
      setProfileSaving(false);
    }
  };
  const addMaterials = async (paths?: string[]) => {
    const r = await api().workProjectAddMaterials?.(dir, paths);
    if (r?.ok) void load();
    else if (!r?.canceled) dispatchHint(r?.error || (zh ? '添加失败' : 'Could not add'), 'warning');
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropOver(false);
    const paths = [...e.dataTransfer.files].map((f) => api().getPathForFile?.(f)).filter((p): p is string => !!p);
    if (paths.length) void addMaterials(paths);
  };
  const send = () => {
    const t = prompt.trim();
    if (!t) return;
    setPrompt('');
    onNewTask(t);
  };

  if (!project) {
    return (
      <div className="nx-pj">
        <button type="button" className="nx-pj__back" onClick={onBack}>‹ {zh ? '返回' : 'Back'}</button>
        <div className="nx-pj__empty">{zh ? '项目不在了（可能被改名或移走）' : 'Project not found'}</div>
      </div>
    );
  }

  return (
    <div className="nx-pj">
      <button type="button" className="nx-pj__back" onClick={onBack}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
        {zh ? '返回' : 'Back'}
      </button>
      <div className="nx-pp__head">
        <img className="nx-pp__art" src={projectArt(project.icon)} alt="" draggable={false} />
        <div style={{ minWidth: 0 }}>
          <div className="nx-pp__name">{project.name}</div>
          <div className="nx-pp__sub">
            {zh ? '工作' : 'Work'} / {project.name} · {zh ? `${tasks.length} 个任务` : `${tasks.length} tasks`} · {zh ? `${detail.fileCount} 个文件` : `${detail.fileCount} files`}
          </div>
        </div>
        <button type="button" className="nx-pp__ghost" onClick={() => {
          const api = (window as { neox?: { surfaceOpenExternal?: (p: string) => Promise<{ success?: boolean; error?: string }> } }).neox;
          void api?.surfaceOpenExternal?.(dir).then((r) => {
            if (r?.success !== false) return;
            dispatchHint(`${zh ? '打开文件夹失败' : 'Couldn’t open the folder'}${r.error ? `：${r.error}` : ''}`, 'warning');
          }).catch((e: any) => dispatchHint(`${zh ? '打开文件夹失败' : 'Couldn’t open the folder'}：${e?.message || e}`, 'warning'));
        }}>{zh ? '打开文件夹' : 'Open folder'}</button>
      </div>

      <div className="nx-pp__composer">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          placeholder={zh ? `在「${project.name}」里新建任务…` : `New task in “${project.name}”…`}
          rows={2}
        />
        <div className="nx-pp__composer-bar">
          <button type="button" className="nx-pp__send" disabled={!prompt.trim()} onClick={send} aria-label={zh ? '发送' : 'Send'}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" /></svg>
          </button>
        </div>
      </div>

      <div className="nx-pp__cards">
        <div className="nx-pp__card">
          <div className="nx-pp__card-head">
            <span className="nx-pp__card-title">{zh ? '项目说明' : 'Notes'}</span>
            <span className="nx-pp__card-hint">{zh ? '每个任务都会带上' : 'Every task reads this'}</span>
            {!editing && <button type="button" className="nx-pp__link" onClick={() => { setDraft(detail.notes); setEditing(true); }}>· {zh ? '编辑' : 'Edit'}</button>}
          </div>
          {editing ? (
            <>
              <textarea
                autoFocus
                className="nx-pp__notes-edit"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveNotes(); }}
                placeholder={zh ? '比如：门店在杭州西湖区。周报每周一出，格式照上周那份；金额用万元、保留一位小数。' : 'Long-lived conventions: formats, tone, numbers…'}
              />
              <div className="nx-pp__notes-bar">
                <button type="button" className="nx-pp__btn" onClick={() => setEditing(false)}>{zh ? '取消' : 'Cancel'}</button>
                <button type="button" className="nx-pp__btn is-primary" onClick={() => void saveNotes()}>{zh ? '保存' : 'Save'}</button>
              </div>
            </>
          ) : (
            <div
              className={`nx-pp__notes${detail.notes.trim() ? '' : ' is-empty'}`}
              onDoubleClick={() => { setDraft(detail.notes); setEditing(true); }}
            >
              {detail.notes.trim() || (zh ? '写下这个项目的长期约定：口径、格式、风格……项目里每个任务都会照着来。' : 'Write the conventions every task in this project should follow.')}
            </div>
          )}
        </div>

        {/* 项目口径 (work:Q-11): 受众 / 口吻 / 模板 / 禁写项 —— 同一客户第二份材料不用再重说 */}
        <div className="nx-pp__card is-wide">
          <div className="nx-pp__card-head">
            <span className="nx-pp__card-title">{zh ? '项目口径' : 'Project brief'}</span>
            <span className="nx-pp__card-hint">{zh ? '每个任务都会带上，不用再重说' : 'Applied to every task'}</span>
          </div>
          <div className="nx-pp__profile">
            {PROFILE_ROWS.map((row) => (
              <label key={row.key} className="nx-pp__field">
                <span className="nx-pp__field-label">{zh ? row.zh : row.en}</span>
                <input
                  className="nx-pp__field-input"
                  value={profileDraft[row.key] ?? ''}
                  placeholder={zh ? row.phZh : row.phEn}
                  onChange={(e) => setProfileDraft((p) => ({ ...p, [row.key]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveProfile(); } }}
                />
              </label>
            ))}
          </div>
          <div className="nx-pp__notes-bar">
            <button type="button" className="nx-pp__btn is-primary" disabled={profileSaving} onClick={() => void saveProfile()}>
              {profileSaving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存口径' : 'Save')}
            </button>
          </div>
        </div>
        <div
          className={`nx-pp__card${dropOver ? ' is-drop' : ''}`}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropOver(true); } }}
          onDragLeave={() => setDropOver(false)}
          onDrop={onDrop}
        >
          <div className="nx-pp__card-head">
            <span className="nx-pp__card-title">{zh ? '资料' : 'Files'}</span>
            <span className="nx-pp__card-hint">{zh ? '拖文件进来' : 'Drop files here'}</span>
            <button type="button" className="nx-pp__link" onClick={() => void addMaterials()}>· {zh ? '添加' : 'Add'}</button>
          </div>
          {detail.materials.length === 0 ? (
            <div className="nx-pp__drop">{zh ? '把表格、品牌规范、照片拖进来，项目里每个任务都能用' : 'Drop spreadsheets, guides, photos — every task can use them'}</div>
          ) : (
            <div className="nx-pp__mats">
              {detail.materials.slice(0, 6).map((m) => (
                <div key={m.path} className="nx-pp__mat" role="button" tabIndex={0} title={m.path} onClick={() => void api().surfaceOpenExternal?.(m.path)}>
                  <img src={matArt(m)} alt="" style={{ width: 22, height: 22, objectFit: 'contain' }} draggable={false} />
                  <span className="nx-pp__mat-name">{m.name}</span>
                  <span className="nx-pp__mat-meta">{m.isDir ? (zh ? `${m.count ?? 0} 个` : `${m.count ?? 0}`) : shortDay(m.mtime)}</span>
                </div>
              ))}
              {detail.materials.length > 6 && (
                <button type="button" className="nx-pp__link" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => void api().surfaceOpenExternal?.(`${dir}/资料`)}>
                  {zh ? `还有 ${detail.materials.length - 6} 个 ›` : `${detail.materials.length - 6} more ›`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="nx-pp__tasks-head"><b>{zh ? '任务' : 'Tasks'}</b><span>{tasks.length}</span></div>
      {tasks.length === 0 && <div className="nx-pp__no-tasks">{zh ? '还没有任务。在上面输入框说要做什么，任务会放进这个项目。' : 'No tasks yet — type above to start one.'}</div>}
      {tasks.map((t) => {
        const out = glance[t.id]?.outputs?.[0];
        const name = out?.path.split(/[\\/]/).pop();
        const title = displaySessionName(t.name, t.createdAt, zh);
        const running = runningSessionIds.has(t.id);
        const photo = out && IMG_EXT.has(out.ext);
        return (
          <div key={t.id} className="nx-pp__task" role="button" tabIndex={0} onClick={() => onOpenSession(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpenSession(t.id); }}>
            <img className={`nx-pp__task-art${photo ? ' is-photo' : ''}`} src={photo ? assetUrl(out!.path) : artFor(out?.ext, title)} alt="" draggable={false} />
            <div className="nx-pp__task-body">
              <div className="nx-pp__task-title">{title}</div>
              <div className="nx-pp__task-sub">
                {[name, running ? (zh ? '进行中' : 'Running') : (t.messageCount ? (zh ? '已做完' : 'Done') : (zh ? '还没开始' : 'Not started'))].filter(Boolean).join(' · ')}
              </div>
            </div>
            <span className="nx-pp__task-time">{shortDay(t.updatedAt ?? t.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
};

export default WorkProjectPage;
