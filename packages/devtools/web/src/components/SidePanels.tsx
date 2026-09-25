import type { ControlPlaneSnapshot, MonitorAlert, RiskEvent } from '../types';
import { fmtMs, fmtTime } from '../util';

export function StallPanel({ cp }: { cp: ControlPlaneSnapshot }) {
  const rows = cp.inflightStalls;
  return (
    <div className="side-tbl">
      <div className="sect-h">Control Plane · Stalls <span className="badge">{cp.available ? rows.length : '—'}</span></div>
      {!cp.available
        ? <div className="empty">需深度模式(NEOX_DEVTOOLS=1)才有 stall / loop / lock 信号</div>
        : rows.length === 0
          ? <div className="empty">no in-flight stalls ✓</div>
          : (
            <>
              <div className="thead cols-stall"><span>Age</span><span>Label</span><span>Kind</span></div>
              {rows.map((s) => (
                <div className="trow cols-stall" key={s.stallId}>
                  <span className="age">{fmtMs(s.ageMs)}</span>
                  <span className="sl">{s.label}</span>
                  <span className="kind">{s.kind}</span>
                </div>
              ))}
            </>
          )}
    </div>
  );
}

export function RiskPanel({ events }: { events: RiskEvent[] }) {
  return (
    <div className="side-tbl">
      <div className="sect-h">Risk <span className="badge">{events.length}</span><span className="grow" />{events.length > 8 && <span className="viewall">View all »</span>}</div>
      {events.length === 0 ? <div className="empty">no risk events</div> : (
        <>
          <div className="thead cols-risk"><span>Severity</span><span>Message</span><span className="r-num">Time</span></div>
          {events.slice(0, 8).map((r) => (
            <div className="trow cols-risk" key={r.id}>
              <span className={`tag lv-${r.riskLevel || r.level}`}>{r.riskLevel || r.kind}</span>
              <span className="lmsg" title={r.message}>{r.message}</span>
              <span className="lts">{fmtTime(r.ts)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function AlertsPanel({ alerts }: { alerts: MonitorAlert[] }) {
  return (
    <div className="side-tbl">
      <div className="sect-h">Alerts <span className="badge">{alerts.length}</span><span className="grow" />{alerts.length > 8 && <span className="viewall">View all »</span>}</div>
      {alerts.length === 0 ? <div className="empty">no alerts</div> : (
        <>
          <div className="thead cols-alert"><span>Kind</span><span>Message</span><span className="r-num">Time</span></div>
          {alerts.slice(0, 8).map((a) => (
            <div className="trow cols-alert" key={a.id}>
              <span className={`tag lv-${a.level}`}>{a.kind}</span>
              <span className="lmsg" title={a.message}>{a.message}</span>
              <span className="lts">{fmtTime(a.ts)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
