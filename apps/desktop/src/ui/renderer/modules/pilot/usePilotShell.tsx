import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionItem } from '../shell/Sidebar';
import { PilotWelcome, type PilotDraft } from './PilotEditor';
import type { PilotContact } from './PilotSidebar';
import { savePilotProfile, usePilotState } from './pilotStore';
import { pickPilotCallModel, type ModelLike } from './callModel';
import { PilotNav, type PilotPage } from './v3/PilotNav';
import { PilotTodayPage } from './v3/PilotTodayPage';
import { PilotChatHeader, avatarStill } from './v3/PilotChatHeader';
import { PilotTeamDrawer, PilotTeamPage } from './v3/PilotTeamPage';
import { PILOT_LOOKS } from './v3/pilotLooks';
import { PilotMoneyPage } from './v3/PilotMoneyPage';
import { PilotBodyPage } from './v3/PilotBodyPage';
import { PilotPlacesPage } from './v3/PilotPlacesPage';
import { PilotPeoplePage } from './v3/PilotPeoplePage';
import { PilotLifePage } from './v3/PilotLifePage';
import { PilotSettingsPage } from './v3/PilotSettingsPage';
import { PilotNotesPage } from './v3/PilotNotesPage';
import { PilotConnectPage } from './v3/PilotConnectPage';
import { PilotActionCards } from './v3/PilotActionCards';
import { PilotAutoPage } from './v3/PilotAutoPage';
import './pilot.css';
import './v3/pilot-v3.css';

const PAGE_KEY = 'neox:pilot:page';
/* 已经做好的房间 —— 做好一个往这里加一个, 没做好的不露出来 */
const ROOMS: PilotPage[] = ['today', 'chat', 'auto', 'connect', 'notes'];
const BOTTOM: PilotPage[] = ['team', 'settings'];
const SUB_ROOMS: PilotPage[] = ['money', 'body', 'place', 'people', 'life'];
function readPage(): PilotPage {
  try {
    const p = localStorage.getItem(PAGE_KEY) as PilotPage | null;
    return p && (ROOMS.includes(p) || BOTTOM.includes(p) || SUB_ROOMS.includes(p)) ? p : 'today';
  } catch { return 'today'; }
}

interface Runtime {
  activeSession: { id: string; name?: string } | null;
  streaming: boolean;
  runningSessionIds: ReadonlySet<string> | string[];
  createNewSession: () => Promise<{ id: string } | null>;
  renameSession: (id: string, name: string) => Promise<unknown> | void;
  availableModels?: ModelLike[];
  selectedModel?: { id: string } | null;
  sessions?: Array<{ id: string; modelId?: string }>;
  setSelectedModel: (m: any) => void;
  setModelForSession?: (sessionId: string, m: any) => void;
  setEffortForModel: (modelId: string, level: string) => void;
}

interface Input {
  active: boolean;
  /** 已按模式过滤过的会话 (只剩 pilot 池) */
  sessions: SessionItem[];
  runtime: Runtime;
  onSelectSession: (id: string) => void;
}

export interface PilotShell {
  active: boolean;
  sidebar: React.ReactNode | undefined;
  rightPanel: React.ReactNode | undefined;
  sidebarCollapsed: boolean | undefined;
  rightPanelCollapsed: boolean | undefined;
  wrapMain: (main: React.ReactNode) => React.ReactNode;
  overlays: React.ReactNode;
}

export function usePilotShell({ active, sessions, runtime, onSelectSession }: Input): PilotShell {
  const { profiles, call, loaded } = usePilotState();
  const [editor, setEditor] = useState<{ creating: boolean; sessionId?: string } | null>(null);
  const [page, setPage] = useState<PilotPage>(readPage);
  const goPage = useCallback((p: PilotPage) => {
    setPage(p);
    try { localStorage.setItem(PAGE_KEY, p); } catch { /* 不记也行 */ }
  }, []);

  const contacts = useMemo<PilotContact[]>(() => sessions
    .filter((s) => !s.parentSessionId && s.kind !== 'image')
    .map((s) => ({ id: s.id, title: s.title, subtitle: s.subtitle, timeText: s.timeText, ts: s.ts }))
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)), [sessions]);

  const activeId = active ? runtime.activeSession?.id ?? null : null;
  const activeIsPilot = !!activeId && contacts.some((c) => c.id === activeId);

  /* 进 Pilot 模式没选中谁 → 打开最近那个, 像 IM 一样直接落在对话里 */
  const autoPicked = useRef(false);
  useEffect(() => {
    if (!active) { autoPicked.current = false; return; }
    if (activeIsPilot || autoPicked.current || contacts.length === 0) return;
    autoPicked.current = true;
    onSelectSession(contacts[0].id);
  }, [active, activeIsPilot, contacts, onSelectSession]);

  useEffect(() => {
    if (!active) return undefined;
    document.documentElement.setAttribute('data-pilot', '');
    return () => document.documentElement.removeAttribute('data-pilot');
  }, [active]);

  /* 会话名 = Pilot 的名字。引擎现在不给 Pilot 会话起标题了, 这里把之前被起过标题的改回来
   * (顶栏显示的是会话名) —— 每个会话只纠一次, 纠不动也不反复打 IPC */
  const healed = useRef(new Set<string>());
  useEffect(() => {
    if (!active) return;
    for (const c of contacts) {
      const want = profiles[c.id]?.name;
      if (!want || c.title === want || healed.current.has(c.id)) continue;
      healed.current.add(c.id);
      void Promise.resolve(runtime.renameSession(c.id, want)).catch(() => { /* 下次启动再说 */ });
    }
  }, [active, contacts, profiles, runtime]);

  const looked = useRef(new Set<string>());
  useEffect(() => {
    if (!active) return;
    const cats = contacts.filter((c) => profiles[c.id] && profiles[c.id].avatar !== 'corgi')
      .sort((a, b) => (profiles[a.id].createdAt ?? 0) - (profiles[b.id].createdAt ?? 0));
    cats.forEach((c, i) => {
      if (profiles[c.id].look || looked.current.has(c.id)) return;
      looked.current.add(c.id);
      void savePilotProfile(c.id, { look: PILOT_LOOKS[i % 4].id }).catch(() => { /* 下次再派 */ });
    });
  }, [active, contacts, profiles]);

  const create = useCallback(async (d: PilotDraft) => {
    const s = await runtime.createNewSession();
    if (!s) return;
    await runtime.renameSession(s.id, d.name);
    await savePilotProfile(s.id, {
      name: d.name, avatar: d.avatar, look: d.look, persona: d.persona, patrolMinutes: d.patrolMinutes,
      voice: d.voice ?? '', ringReminders: d.ringReminders,
    });
    /* 抽屉里选了模型就用它; 没选: 通话要快, 有 DeepSeek 官方渠道就用它的 flash + 关思考 (新会话此刻就是活跃会话, 选模型即写进它) */
    const picked = d.modelId ? (runtime.availableModels ?? []).find((m) => m.id === d.modelId) : undefined;
    const callModel = picked ?? pickPilotCallModel(runtime.availableModels ?? []);
    if (picked) {
      runtime.setSelectedModel(picked);
    } else if (callModel) {
      runtime.setSelectedModel(callModel);
      runtime.setEffortForModel(callModel.id, 'off');
    }
  }, [runtime]);

  const closeEditor = useCallback(() => setEditor(null), []);

  const saveEdit = useCallback(async (sessionId: string, d: PilotDraft) => {
    const before = profiles[sessionId]?.name;
    await savePilotProfile(sessionId, {
      name: d.name, avatar: d.avatar, look: d.look, persona: d.persona, patrolMinutes: d.patrolMinutes,
      voice: d.voice ?? '', ringReminders: d.ringReminders,
    });
    /* 名字没动就不改会话名 —— 改名会弹「已重命名」, 只换了造型也弹一下很怪 */
    if (d.name !== before) await runtime.renameSession(sessionId, d.name);
    if (d.modelId) {
      const m = (runtime.availableModels ?? []).find((x) => x.id === d.modelId);
      if (m) runtime.setModelForSession?.(sessionId, m);
    }
  }, [profiles, runtime]);

  if (!active) {
    return {
      active: false, sidebar: undefined, rightPanel: undefined,
      sidebarCollapsed: undefined, rightPanelCollapsed: undefined,
      wrapMain: (m) => m, overlays: null,
    };
  }

  const empty = loaded && contacts.length === 0;
  const running = new Set(runtime.runningSessionIds);

  const wrapMain = (main: React.ReactNode) => {
    if (empty) return <PilotWelcome onCreate={create} />;
    return (
      <div className="pv3">
        <PilotNav page={page} rooms={ROOMS} bottom={BOTTOM} onChange={goPage} />
        <div className="pv3-slab">
          <div className="pv3-page" hidden={page !== 'today'}>
            <PilotTodayPage sessionId={activeIsPilot ? activeId : null} onGoChat={() => goPage('chat')} onOpenNotes={() => goPage('notes')} onOpenRoom={goPage} />
          </div>
          {/* 对话页就是聊天记录 (稿 pl1) —— 形象住在「今天」的房间里, 这里不再叠 3D 舞台 */}
          <div
            className="pv3-page pv3-page--chat pilot-conv"
            hidden={page !== 'chat'}
            style={{ '--pv-face': `url(${avatarStill(activeId ? profiles[activeId] : undefined)})` } as React.CSSProperties}
          >
            {activeIsPilot && activeId && (
              <PilotChatHeader
                sessionId={activeId}
                profiles={profiles}
                contacts={contacts}
                call={call}
                onEdit={() => setEditor({ creating: false, sessionId: activeId })}
                onSwitch={onSelectSession}
                onCreate={() => setEditor({ creating: true })}
              />
            )}
            <PilotActionCards sessionId={activeIsPilot ? activeId : null} visible={page === 'chat'} />
            <div className="pilot-conv__body">{main}</div>
          </div>
          {page === 'money' && (
            <div className="pv3-page">
              <PilotMoneyPage sessionId={activeIsPilot ? activeId : null} onGoChat={() => goPage('chat')} />
            </div>
          )}
          {page === 'body' && (
            <div className="pv3-page">
              <PilotBodyPage sessionId={activeIsPilot ? activeId : null} onGoChat={() => goPage('chat')} />
            </div>
          )}
          {page === 'place' && (
            <div className="pv3-page">
              <PilotPlacesPage onGoChat={() => goPage('chat')} />
            </div>
          )}
          {page === 'people' && (
            <div className="pv3-page">
              <PilotPeoplePage sessionId={activeIsPilot ? activeId : null} onGoChat={() => goPage('chat')} />
            </div>
          )}
          {page === 'life' && (
            <div className="pv3-page">
              <PilotLifePage sessionId={activeIsPilot ? activeId : null} onGoChat={() => goPage('chat')} />
            </div>
          )}
          {page === 'auto' && (
            <div className="pv3-page">
              <PilotAutoPage sessionId={activeIsPilot ? activeId : null} />
            </div>
          )}
          {page === 'connect' && (
            <div className="pv3-page">
              <PilotConnectPage />
            </div>
          )}
          {page === 'notes' && (
            <div className="pv3-page">
              <PilotNotesPage sessionId={activeIsPilot ? activeId : null} onGoChat={() => goPage('chat')} />
            </div>
          )}
          {page === 'settings' && (
            <div className="pv3-page">
              <PilotSettingsPage sessionId={activeIsPilot ? activeId : null} />
            </div>
          )}
          <div className="pv3-page" hidden={page !== 'team'}>
            <PilotTeamPage
              contacts={contacts}
              profiles={profiles}
              running={running}
              editingId={editor ? editor.sessionId ?? 'new' : null}
              onTalk={(id) => { onSelectSession(id); goPage('chat'); }}
              onEdit={(id) => setEditor({ creating: false, sessionId: id })}
              onCreate={() => setEditor({ creating: true })}
            />
          </div>
        </div>
        {/* 新建 / 编辑分身: 泥板右边一块抽屉 (稿 pl7), 哪一页打开都一样; key 换人就重置表单 */}
        {editor && (
          <PilotTeamDrawer
            key={editor.sessionId ?? 'new'}
            creating={editor.creating}
            initial={editor.sessionId ? profiles[editor.sessionId] ?? { name: contacts.find((c) => c.id === editor.sessionId)?.title } : undefined}
            onSubmit={(d) => (editor.creating || !editor.sessionId ? create(d) : saveEdit(editor.sessionId, d))}
            onClose={closeEditor}
            models={(runtime.availableModels ?? []).filter((m) => !m.id.startsWith('default:')).map((m) => ({ id: m.id, name: (m as { name?: string }).name }))}
            modelId={!editor.sessionId ? null
              : editor.sessionId === runtime.activeSession?.id ? runtime.selectedModel?.id ?? null
              : runtime.sessions?.find((s) => s.id === editor.sessionId)?.modelId ?? null}
          />
        )}
      </div>
    );
  };

  const overlays = null;

  return {
    active: true,
    sidebar: undefined,
    rightPanel: undefined,
    sidebarCollapsed: true,
    rightPanelCollapsed: true,
    wrapMain,
    overlays,
  };
}
