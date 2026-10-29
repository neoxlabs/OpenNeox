import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useSubAgents } from '../../state/subAgentsStore';
import { useTimelineFeed } from '../../state/timelineFeedStore';
import { formatSessionTime } from '../../app/sessionItemMapping';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { latestPlan, planName } from '../agent-timeline/PlanStatusBar';
import type { TimelineEntry } from '../../utils/workspaceUtils';
import type { CallLogEntry, PilotProfile } from './pilotStore';
import { reportsApi, useMarkReportsSeen, usePilotReports, type PilotReport } from './usePilotReports';
import { boardApi, SectionHead, splitWhen, type BoardMemory } from './board/boardKit';
import { AgendaSection, useAgenda } from './board/AgendaSection';
import { ReportsSection } from './board/ReportsSection';
import { MemorySection } from './board/MemorySection';
import { CallsSection } from './board/CallsSection';
import { ART, weatherArt, type ArtName } from './board/art';
import { useMadeFiles, usePhone, usePlace, useWeather } from './board/boardData';
import {
  Detail, FilesDetail, FilesWidget, MapDetail, MapWidget, PhoneWidget, StatWidget, TodayWidget, WeatherDetail,
} from './board/widgets';
import './board/board.css';

interface Props {
  sessionId: string | null;
  log: CallLogEntry[];
  profile?: PilotProfile;
}

/* 一句话就能交代的事 (用户点名的几个场景)。点了直接发, 细节它会追问 */
const STARTERS: Array<{ art: ArtName; zh: string; en: string; promptZh: string; promptEn: string }> = [
  { art: 'alarm', zh: '每天叫我起床', en: 'Wake me daily', promptZh: '每天早上叫我起床。先问我几点、打电话叫还是定手机闹钟。', promptEn: 'Wake me up every morning. Ask me what time, and whether to call me or set a phone alarm.' },
  { art: 'eye', zh: '盯紧一个项目', en: 'Watch a project', promptZh: '帮我盯紧一个项目的进度。先问我是哪个项目、去哪看进度、多久跟我说一次。', promptEn: 'Keep an eye on a project for me. Ask which one, where to check progress, and how often to report.' },
  { art: 'wrench', zh: '解决一个问题', en: 'Fix a problem', promptZh: '帮我把一个项目里的问题解决掉。先问我是哪个项目、什么问题。', promptEn: 'Fix a problem in one of my projects. Ask which project and what the problem is.' },
  { art: 'lunch', zh: '中午吃什么', en: 'Find lunch', promptZh: '中午帮我找点吃的。先看我在哪, 再挑附近几家给我选。', promptEn: 'Find me some lunch. Check where I am, then pick a few places nearby.' },
];

const DONE = new Set(['completed', 'done']);
const ACTIVE = new Set(['in_progress', 'verifying']);

type DetailKey = 'weather' | 'map' | 'files' | 'reports' | 'memory' | 'calls' | null;

export const PilotBoard: React.FC<Props> = ({ sessionId, log, profile }) => {
  const { isZh } = useI18n();
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const agents = useSubAgents(sessionId);
  const feed = useTimelineFeed();
  /* 每做完一轮 (多一条回话) 重拉一次: 它在对话里定的提醒 / 记下的事, 没有本机变更通知 */
  const replies = useMemo(() => (feed ?? []).filter((e) => (e as { type?: string }).type === 'assistant_message').length, [feed]);
  const agenda = useAgenda(sessionId, replies);
  const place = usePlace();
  const { weather } = useWeather(place);
  const phone = usePhone();
  const made = useMadeFiles(feed as TimelineEntry[] | null, sessionId);
  const [detail, setDetail] = useState<DetailKey>(null);
  /* 它记得几件事 (小方块上的数); 详情页里增删后回来重拉 */
  const [memories, setMemories] = useState<BoardMemory[] | null>(null);
  useEffect(() => {
    if (!sessionId || detail) return undefined;
    let alive = true;
    void boardApi().pilotMemories?.(sessionId).then((r) => { if (alive) setMemories(r?.cloud ? [...r.memories].sort((a, b) => b.at - a.at) : null); }).catch(() => undefined);
    return () => { alive = false; };
  }, [sessionId, replies, detail]);

  const plan = useMemo(() => latestPlan((feed ?? []) as TimelineEntry[]), [feed]);
  const planDone = plan ? plan.steps.filter((s) => DONE.has(s.status ?? '')).length : 0;
  const planOpen = !!plan && planDone < plan.steps.length;
  const planNow = plan?.steps.find((s) => ACTIVE.has(s.status ?? '')) ?? plan?.steps.find((s) => !DONE.has(s.status ?? ''));

  /* 汇报账本: Pilot 没有 ask_user (不会停下来等人), 要你定的事都以 blocked 汇报出现在这里 */
  const allReports = usePilotReports();
  useMarkReportsSeen(sessionId, allReports);
  const mine = allReports.filter((r) => r.sessionId === sessionId);
  const decisions = mine.filter((r) => r.status === 'blocked' && !r.answer);
  const reports = mine.filter((r) => r.status !== 'blocked' || r.answer);
  const unread = reports.filter((r) => !r.readAt).length;

  const runtime = useNeoxRuntimeOptional();
  const send = runtime ? (text: string) => runtime.sendPrompt(text) : null;
  const ask = send ? (text: string) => { void send(text); setDetail(null); } : null;
  const [answering, setAnswering] = useState<string | null>(null);
  const [replyFor, setReplyFor] = useState<Record<string, string>>({});
  const decide = async (r: PilotReport, value: string) => {
    if (!runtime || answering || !value.trim()) return;
    setAnswering(r.id);
    try {
      await reportsApi().pilotReportAnswer?.(r.id, value);
      await runtime.sendPrompt(isZh ? `「${r.title}」: ${value}` : `"${r.title}": ${value}`);
      setReplyFor((m) => ({ ...m, [r.id]: '' }));
    } catch { /* 发不出去就留在板上, 下次再点 */ } finally {
      setAnswering(null);
    }
  };

  const running = agents.filter((a) => a.status === 'running');
  const doingCount = (planOpen ? 1 : 0) + running.length;
  const patrol = profile?.patrolMinutes ?? 0;
  const statusLine = doingCount > 0
    ? t(`正在办 ${doingCount} 件`, `${doingCount} in progress`)
    : patrol > 0 ? t(`空闲 · 每 ${patrol >= 60 ? `${Math.round(patrol / 60)} 小时` : `${patrol} 分钟`}巡一次`, `Idle · checks every ${patrol} min`) : t('空闲，随时交代', 'Idle — ready');
  const nextRem = agenda.rows.find((r) => (r.scheduledAt ?? 0) > Date.now());
  const next = nextRem ? { when: splitWhen(nextRem.scheduledAt, isZh).join(' '), title: nextRem.title } : null;

  const myCalls = log.filter((c) => c.sessionId === sessionId);
  const lastCall = myCalls[0];

  if (detail) {
    const back = () => setDetail(null);
    return (
      <aside className="pilot-board" aria-label={t('任务', 'Tasks')}>
        {detail === 'weather' && <Detail isZh={isZh} art={weatherArt(weather?.code ?? 1, weather?.isDay ?? true)} title={t('天气', 'Weather')} onBack={back}><WeatherDetail isZh={isZh} place={place} weather={weather} ask={ask} /></Detail>}
        {detail === 'map' && <Detail isZh={isZh} art={ART.map} title={t('位置', 'Location')} onBack={back}><MapDetail isZh={isZh} place={place} ask={ask} /></Detail>}
        {detail === 'files' && <Detail isZh={isZh} art={ART.files} title={t('文件柜', 'Files')} onBack={back}><FilesDetail isZh={isZh} sessionId={sessionId} /></Detail>}
        {detail === 'reports' && <Detail isZh={isZh} art={ART.reports} title={t('汇报', 'Reports')} onBack={back}><ReportsSection reports={reports} isZh={isZh} send={send} /></Detail>}
        {detail === 'memory' && <Detail isZh={isZh} art={ART.memory} title={t('它记得', 'It remembers')} onBack={back}><MemorySection sessionId={sessionId} refreshKey={replies} isZh={isZh} /></Detail>}
        {detail === 'calls' && <Detail isZh={isZh} art={ART.calls} title={t('通话', 'Calls')} onBack={back}><CallsSection sessionId={sessionId} log={log} isZh={isZh} /></Detail>}
      </aside>
    );
  }

  return (
    <aside className="pilot-board" aria-label={t('任务', 'Tasks')}>
      <TodayWidget isZh={isZh} place={place} weather={weather} busy={doingCount > 0} statusLine={statusLine} next={next} onWeather={() => setDetail('weather')} />

      {decisions.length > 0 && (
        <section className="pb-sec is-ask">
          <SectionHead art={ART.decide} title={t('等你拍板', 'Needs you')} count={decisions.length} accent />
          {decisions.map((r) => (
            <div key={r.id} className="pb-ask">
              <div className="pb-ask__title">{r.title}</div>
              {r.summary && <div className="pb-ask__summary">{r.summary}</div>}
              <div className="pb-ask__choices">
                {(r.options?.length ? r.options : [t('好, 就这么办', 'Go ahead'), t('先别', 'Hold off')]).map((o, i) => (
                  <button key={o} type="button" className={`pb-choice${i === 0 ? ' is-primary' : ''}`} disabled={answering === r.id} onClick={() => void decide(r, o)}>
                    {o}
                  </button>
                ))}
              </div>
              <input
                className="pb-input pb-input--ask"
                placeholder={t('或者回它一句，回车发送', 'Or reply, Enter to send')}
                value={replyFor[r.id] ?? ''}
                disabled={answering === r.id}
                onChange={(e) => setReplyFor((m) => ({ ...m, [r.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void decide(r, replyFor[r.id] ?? ''); }}
              />
            </div>
          ))}
        </section>
      )}

      {doingCount > 0 && (
        <section className="pb-sec is-doing">
          <SectionHead art={ART.wrench} title={t('正在办', 'Doing')} count={doingCount} />
          {planOpen && plan && (
            <div className="pb-plan">
              <div className="pb-plan__top">
                <span className="pb-plan__name">{planName(plan) || planNow?.content || t('计划', 'Plan')}</span>
                <span className="pb-plan__count">{planDone}/{plan.steps.length}</span>
              </div>
              <div className="pb-plan__bar" aria-hidden>
                <span style={{ width: `${Math.round((planDone / plan.steps.length) * 100)}%` }} />
              </div>
              {planNow?.content && planName(plan) && <div className="pb-plan__now">{planNow.content}</div>}
            </div>
          )}
          {running.map((a) => (
            <div key={a.agentId} className="pb-run">
              <span className="pb-run__pulse" aria-hidden />
              <span className="pb-run__what">{a.description || a.name}</span>
              <span className="pb-run__n">{a.toolUseCount}</span>
            </div>
          ))}
        </section>
      )}

      {sessionId && <AgendaSection agenda={agenda} isZh={isZh} />}

      {made.length > 0 && <FilesWidget isZh={isZh} sessionId={sessionId} files={made} onBrowse={() => setDetail('files')} />}

      <div className="pw-grid">
        <MapWidget isZh={isZh} place={place} onOpen={() => setDetail('map')} />
        <PhoneWidget isZh={isZh} phone={phone} />
        <StatWidget
          art={ART.reports}
          big={unread > 0 ? t(`${unread} 条新`, `${unread} new`) : String(reports.length)}
          label={t('汇报', 'Reports')}
          sub={reports[0]?.title}
          dot={unread > 0}
          onClick={() => setDetail('reports')}
        />
        <StatWidget
          art={ART.memory}
          big={memories && memories.length > 0 ? t(`${memories.length} 件事`, `${memories.length} things`) : t('教它', 'Teach it')}
          label={t('它记得', 'It remembers')}
          sub={memories?.[0]?.text ?? t('你的习惯和约定', 'Your habits')}
          onClick={() => setDetail('memory')}
        />
        <StatWidget
          art={ART.calls}
          big={lastCall ? formatSessionTime(lastCall.at) : t('打给它', 'Call it')}
          label={t('通话', 'Calls')}
          sub={lastCall ? (lastCall.direction === 'outgoing' ? t('你打给它', 'You called') : lastCall.reason || t('它打给你', 'It called')) : undefined}
          onClick={() => setDetail('calls')}
        />
        {made.length === 0 && <FilesWidget isZh={isZh} sessionId={sessionId} files={made} onBrowse={() => setDetail('files')} />}
      </div>

      <section className="pb-sec is-starters">
        <h3 className="pb-head pb-head--plain">{t('交代它', 'Ask it to')}</h3>
        <div className="pw-starters">
          {STARTERS.map((st) => (
            <button key={st.zh} type="button" className="pw-starter" disabled={!runtime} onClick={() => void runtime?.sendPrompt(isZh ? st.promptZh : st.promptEn)}>
              <img src={ART[st.art]} alt="" draggable={false} />
              <span>{isZh ? st.zh : st.en}</span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
};
