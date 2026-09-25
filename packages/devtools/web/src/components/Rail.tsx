/** 左侧图标导航栏(视觉对齐设计图;当前单页, 后续可挂路由) */
const ICONS: Array<{ id: string; title: string; path: string }> = [
  { id: 'overview', title: 'Overview', path: 'M3 12l9-9 9 9M5 10v10h14V10' },
  { id: 'sessions', title: 'Sessions', path: 'M4 6h16M4 12h16M4 18h10' },
  { id: 'agents', title: 'Agents', path: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0' },
  { id: 'risk', title: 'Risk', path: 'M12 3l9 16H3z M12 10v4 M12 17v.5' },
  { id: 'metrics', title: 'Metrics', path: 'M4 19V5M4 19h16M8 16l3-4 3 2 4-6' },
  { id: 'settings', title: 'Settings', path: 'M12 9a3 3 0 100 6 3 3 0 000-6z M19 12l1.5 1-1 2-1.8-.4-1.2 1.5.2 1.8-2 .8-1.2-1.5h-2L10 21l-2-.8.2-1.8-1.2-1.5L5 17.4l-1-2L5.5 14' },
];

export function Rail() {
  return (
    <div className="rail">
      <span className="logo-dot" />
      {ICONS.map((ic, i) => (
        <button key={ic.id} className={`rail-btn ${i === 0 ? 'active' : ''}`} title={ic.title} aria-label={ic.title}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d={ic.path} />
          </svg>
        </button>
      ))}
      <span className="spacer" />
    </div>
  );
}
