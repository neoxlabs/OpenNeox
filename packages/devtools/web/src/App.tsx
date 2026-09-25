import { useMonitorStream } from './api';
import { useMetricHistory } from './history';
import { useTheme } from './theme';
import { Rail } from './components/Rail';
import { TopBar } from './components/TopBar';
import { KpiStrip } from './components/KpiStrip';
import { SessionsPanel } from './components/SessionsPanel';
import { StallPanel, RiskPanel, AlertsPanel } from './components/SidePanels';

export function App() {
  const { state, live } = useMonitorStream();
  const history = useMetricHistory(state);
  const { theme, toggle } = useTheme();

  return (
    <div className="shell">
      <Rail />
      <div className="content">
        <TopBar state={state} live={live} theme={theme} onToggle={toggle} />
        {!state ? (
          <div className="center">
            <div>
              <div className="big">Connecting…</div>
              <div>等待 <span className="mono">neox-devtools serve</span> 桥接数据流</div>
            </div>
          </div>
        ) : (
          <>
            <KpiStrip state={state} history={history} />
            <div className="main">
              <SessionsPanel sessions={state.sessions} history={history} />
              <div className="col-side">
                <StallPanel cp={state.controlPlane} />
                <RiskPanel events={state.riskEvents} />
                <AlertsPanel alerts={state.alerts} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
