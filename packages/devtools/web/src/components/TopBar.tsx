import type { MonitorState } from '../types';
import type { Theme } from '../theme';
import { fmtTime } from '../util';

export function TopBar({ state, live, theme, onToggle }: {
  state: MonitorState | null; live: boolean; theme: Theme; onToggle: () => void;
}) {
  const connected = live && !!state?.connected;
  return (
    <div className="topbar">
      <div className="logo"><span>Neox</span><span className="sep">/</span><span className="sub">Agent Monitor</span></div>
      {state && <span className={`chip ${state.mode === 'attached' ? 'on' : ''}`}>{state.mode === 'attached' ? 'deep' : 'subscribe'}</span>}
      {state && <span className="chip">{state.mode === 'attached' ? 'subscribe' : 'deep'}</span>}
      {state?.endpoint && <span className="chip">{state.endpoint.host}:{state.endpoint.port}</span>}

      <div className="tb-right">
        <div className={`conn ${connected ? 'live' : ''}`}>
          <span className="led" />
          <span>{connected ? 'live' : 'disconnected'}</span>
          {state && <span className="meta">· {state.eventsReceived} events · {fmtTime(state.lastUpdatedAt)}</span>}
        </div>
        <button className="toggle" onClick={onToggle} title="切换主题" aria-label="toggle theme"><i /></button>
      </div>
    </div>
  );
}
