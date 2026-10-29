import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { formatSessionTime } from '../../../app/sessionItemMapping';
import { FileTypeIcon } from '../../../components/FileTypeIcon';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { reportsApi, usePilotReports, type PilotReport } from '../usePilotReports';
import { boardApi, type BoardMemory } from '../board/boardKit';
import { dataApi, fmtSize, type PilotFile } from '../board/boardData';

type Tab = 'reports' | 'memory' | 'files';

const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const I = {
  done: <svg {...S}><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></svg>,
  ask: <svg {...S}><circle cx="12" cy="12" r="8.5" /><path d="M9.8 9.6a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.4M12 16.6h.01" /></svg>,
  fail: <svg {...S}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.8v5M12 16.2h.01" /></svg>,
  doing: <svg {...S}><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4.5v4h-4" /></svg>,
  folder: <svg {...S}><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></svg>,
  x: <svg {...S} width={14} height={14}><path d="M6 6l12 12M18 6 6 18" /></svg>,
};
/** 汇报正文是 markdown, 卡片里只要两行字: 去掉 ** / # / 行首列表符 */
const plain = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/^\s*(#{1,6}\s+|[-*]\s+|\d+\.\s+)/gm, '').replace(/\s*\n\s*/g, ' ');
const statusIcon =(r: PilotReport) => (r.status === 'failed' ? I.fail : r.status === 'blocked' ? I.ask : r.status === 'progress' ? I.doing : I.done);

/** 它记得的 (云端 Pilot 才有); 本机 Pilot 返回 null */
function useMemories(sessionId: string | null) {
  const [rows, setRows] = useState<BoardMemory[] | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!sessionId) { setRows(null); return undefined; }
    let alive = true;
    void boardApi().pilotMemories?.(sessionId).then((r) => {
      if (alive) setRows(r?.cloud ? [...r.memories].sort((a, b) => b.at - a.at) : null);
    }).catch(() => { if (alive) setRows(null); });
    return () => { alive = false; };
  }, [sessionId, nonce]);
  return { rows, refresh: useCallback(() => setNonce((n) => n + 1), []) };
}

/** 它工作区某一层的文件 (新的在前, 目录排前面) */
function useFiles(sessionId: string | null, dir: string) {
  const [items, setItems] = useState<PilotFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!sessionId) return undefined;
    let alive = true;
    setErr(null);
    void dataApi().pilotFiles?.(sessionId, dir).then((r) => {
      if (!alive) return;
      if (r?.ok) setItems((r.items ?? []).filter((i) => !i.name.startsWith('.')).sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || b.mtime - a.mtime));
      else setErr(r?.error ?? 'failed');
    }).catch((e: Error) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [sessionId, dir]);
  return { items, err };
}

interface Props {
  sessionId: string | null;
  onGoChat: () => void;
}

export const PilotNotesPage: React.FC<Props> = ({ sessionId, onGoChat }) => {
  const { isZh } = useI18n();
  const runtime = useNeoxRuntimeOptional() as { sendPrompt?: (t: string) => Promise<unknown> } | null;
  const [tab, setTab] = useState<Tab>('reports');
  const reports = usePilotReports().filter((r) => !sessionId || !r.sessionId || r.sessionId === sessionId).sort((a, b) => (b.lastAt ?? b.at) - (a.lastAt ?? a.at));
  const mem = useMemories(sessionId);
  const [dir, setDir] = useState('.');
  const files = useFiles(sessionId, dir);
  const rootFiles = useFiles(sessionId, '.');
  const [open, setOpen] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [teach, setTeach] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);

  const say = async (text: string) => {
    if (!text.trim()) return;
    await runtime?.sendPrompt?.(text.trim());
    onGoChat();
  };
  const answer = async (r: PilotReport, value: string) => {
    await reportsApi().pilotReportAnswer?.(r.id, value).catch(() => null);
    await say(isZh ? `「${r.title}」: ${value}` : `"${r.title}": ${value}`);
  };
  const openFile = async (f: PilotFile, mode: 'open' | 'save') => {
    if (!sessionId || busy) return;
    setBusy(`${mode}:${f.path}`);
    setFileErr(null);
    const r = await dataApi().pilotOpenFile?.(sessionId, f.path, mode).catch((e: Error) => ({ ok: false, error: e.message }));
    setBusy(null);
    if (!r?.ok) setFileErr((r as { error?: string })?.error ?? 'failed');
  };
  const addMemory = async () => {
    const v = teach.trim();
    if (!v || !sessionId) return;
    setTeach('');
    await boardApi().pilotAddMemory?.(sessionId, v).catch(() => null);
    mem.refresh();
  };
  const forget = async (id: string) => {
    await boardApi().pilotForgetMemory?.(id).catch(() => null);
    mem.refresh();
  };

  const TABS: Array<[Tab, string]> = [['reports', isZh ? '汇报' : 'Reports'], ['memory', isZh ? '它记得' : 'Remembers'], ['files', isZh ? '它做的文件' : 'Files']];
  const unread = reports.filter((r) => !r.readAt).length;
  const recentFiles = (rootFiles.items ?? []).filter((f) => f.type !== 'dir').slice(0, 3);
  const crumbs = dir === '.' ? [] : dir.split('/');

  const fileRow = (f: PilotFile) => (
    <li key={f.path}>
      {f.type === 'dir' ? (
        <button type="button" className="pv3-file" onClick={() => setDir(f.path)}>
          <span className="pv3-file__ic">{I.folder}</span>
          <span className="pv3-list__main"><b>{f.name}</b></span>
        </button>
      ) : (
        <div className="pv3-file">
          <span className="pv3-file__ic"><FileTypeIcon path={f.name} size={30} /></span>
          <span className="pv3-list__main"><b>{f.name}</b><small>{[fmtSize(f.size), f.mtime ? formatSessionTime(f.mtime) : ''].filter(Boolean).join(' · ')}</small></span>
          <button type="button" className="pv3-pill pv3-pill--soft" disabled={!!busy} onClick={() => void openFile(f, 'open')}>
            {busy === `open:${f.path}` ? (isZh ? '打开中…' : 'Opening…') : (isZh ? '打开' : 'Open')}
          </button>
        </div>
      )}
    </li>
  );

  return (
    <div className="pv3-room pv3-notes">
      <div className="pv3-notes__main">
        <h1 className="pv3-pagehead">{isZh ? '它替你记着的' : 'What it keeps for you'}</h1>
        <div className="pv3-tabs" role="tablist">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`pv3-tabs__tab${tab === k ? ' is-on' : ''}`} onClick={() => setTab(k)}>
              {label}{k === 'reports' && unread > 0 && <i className="pv3-tabs__dot" aria-hidden />}
            </button>
          ))}
        </div>

        {tab === 'reports' && (
          reports.length === 0 ? <p className="pv3-box pv3-box__empty pv3-notes__empty">{isZh ? '它办完事、卡住了、要你拍板的时候，条子会交到这里' : 'Reports it files land here'}</p> : (
            <div className="pv3-notes__list">
              {reports.map((r) => {
                const isOpen = open === r.id;
                const waiting = r.status === 'blocked' && !r.answer;
                return (
                  <article key={r.id} className={`pv3-box pv3-report is-${r.status}${r.readAt ? '' : ' is-unread'}`}>
                    <span className="pv3-report__ic">{statusIcon(r)}</span>
                    <div className="pv3-report__body">
                      <h3>{r.title}{!r.readAt && <em>{isZh ? '新' : 'New'}</em>}{(r.repeats ?? 0) > 0 && <small> ×{(r.repeats ?? 0) + 1}</small>}</h3>
                      {r.summary && <p className={isOpen ? 'is-full' : undefined}>{plain(r.summary)}</p>}
                      {r.answer && <p className="pv3-report__ans">{isZh ? '你的答复：' : 'You answered: '}{r.answer}</p>}
                      <span className="pv3-report__meta">{formatSessionTime(r.lastAt ?? r.at)}</span>
                      {waiting && (r.options?.length ?? 0) > 0 && (
                        <div className="pv3-report__opts">
                          {r.options!.map((o) => <button key={o} type="button" className="pv3-pill" onClick={() => void answer(r, o)}>{o}</button>)}
                        </div>
                      )}
                      {isOpen && (
                        <input
                          className="pv3-report__reply"
                          placeholder={isZh ? '回它一句，回车发送' : 'Reply, Enter to send'}
                          value={reply}
                          autoFocus
                          onChange={(e) => setReply(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing && reply.trim()) {
                              const v = reply; setReply(''); setOpen(null);
                              void (waiting ? answer(r, v) : say(isZh ? `关于「${r.title}」：${v}` : `About "${r.title}": ${v}`));
                            }
                          }}
                        />
                      )}
                    </div>
                    <button type="button" className="pv3-pill pv3-pill--soft" onClick={() => { setOpen(isOpen ? null : r.id); setReply(''); }}>
                      {isOpen ? (isZh ? '收起' : 'Close') : waiting ? (isZh ? '回它' : 'Reply') : (isZh ? '打开' : 'Open')}
                    </button>
                  </article>
                );
              })}
            </div>
          )
        )}

        {tab === 'memory' && (
          <section className="pv3-box">
            {mem.rows === null ? (
              <p className="pv3-box__empty">{isZh ? '这个分身在本机跑，记忆在它的对话里，不单独列' : 'This Pilot runs locally; its memory lives in the chat'}</p>
            ) : (
              <>
                <ul className="pv3-list pv3-list--ruled">
                  {mem.rows.map((m) => (
                    <li key={m.id} className="pv3-mem">
                      <span className="pv3-list__main"><b>{m.text}</b><small>{formatSessionTime(m.at)}</small></span>
                      <button type="button" className="pv3-mem__x" title={isZh ? '不对, 删掉' : 'Forget'} aria-label={isZh ? '删掉' : 'Forget'} onClick={() => void forget(m.id)}>{I.x}</button>
                    </li>
                  ))}
                </ul>
                <input
                  className="pv3-report__reply"
                  placeholder={isZh ? '教它一条，比如「我不吃香菜」，回车记下' : 'Teach it something, Enter to save'}
                  value={teach}
                  onChange={(e) => setTeach(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void addMemory(); }}
                />
              </>
            )}
          </section>
        )}

        {tab === 'files' && (
          <section className="pv3-box">
            {crumbs.length > 0 && (
              <div className="pv3-crumbs">
                <button type="button" onClick={() => setDir('.')}>{isZh ? '全部' : 'All'}</button>
                {crumbs.map((c, i) => <React.Fragment key={i}><span>/</span><button type="button" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button></React.Fragment>)}
              </div>
            )}
            {files.err ? <p className="pv3-box__empty">{files.err}</p>
              : files.items === null ? <p className="pv3-box__empty">{isZh ? '正在连它的工作区…' : 'Connecting…'}</p>
              : files.items.length === 0 ? <p className="pv3-box__empty">{isZh ? '还没有文件' : 'No files yet'}</p>
              : <ul className="pv3-list pv3-list--ruled">{files.items.map(fileRow)}</ul>}
            {fileErr && <p className="pv3-box__empty is-err">{fileErr}</p>}
          </section>
        )}
      </div>

      <div className="pv3-notes__side">
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '它记得 · 最近' : 'Remembers · recent'}</h2>
          {(mem.rows?.length ?? 0) === 0 ? <p className="pv3-box__empty">{isZh ? '还没有' : 'Nothing yet'}</p> : (
            <ul className="pv3-list pv3-list--ruled">
              {mem.rows!.slice(0, 4).map((m) => <li key={m.id}><span className="pv3-list__main"><b>{m.text}</b></span></li>)}
            </ul>
          )}
          {(mem.rows?.length ?? 0) > 4 && <button type="button" className="pv3-wide" onClick={() => setTab('memory')}>{isZh ? `全部 ${mem.rows!.length} 条` : `All ${mem.rows!.length}`}</button>}
        </section>
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '它做的文件' : 'Files it made'}</h2>
          {recentFiles.length === 0 ? <p className="pv3-box__empty">{isZh ? '还没有' : 'Nothing yet'}</p> : (
            <ul className="pv3-list pv3-list--ruled">{recentFiles.map(fileRow)}</ul>
          )}
        </section>
      </div>
    </div>
  );
};

export default PilotNotesPage;
