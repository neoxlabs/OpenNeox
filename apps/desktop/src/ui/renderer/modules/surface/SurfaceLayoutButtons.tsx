import React from 'react';
import { usePanelLayout, useActivePanelTab, setPanelLayout, setActiveTab } from '../../state/panelLayoutStore';

/* 图标形状保留 (窄宽 / 以后做图标档时用) */
const ICON = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const SurfaceLayoutButtons: React.FC<{ isZh: boolean }> = ({ isZh }) => {
  const layout = usePanelLayout();
  const tab = useActivePanelTab();
  const items = [
    {
      key: 'dock', on: layout === 'split', label: isZh ? '停靠在右' : 'Dock right', short: isZh ? '停靠' : 'Dock',
      go: () => setPanelLayout('split'),
      icon: <svg {...ICON}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="M9.5 3v10" /></svg>,
    },
    {
      key: 'float', on: layout === 'float', label: isZh ? '悬浮' : 'Float', short: isZh ? '悬浮' : 'Float',
      go: () => setPanelLayout('float'),
      icon: <svg {...ICON}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" opacity=".45" /><rect x="6.5" y="5.5" width="6" height="5" rx="1.2" /></svg>,
    },
    {
      key: 'expand', on: layout === 'tabs' && tab === 'surface', label: isZh ? '展开铺满' : 'Expand', short: isZh ? '展开' : 'Expand',
      go: () => { setPanelLayout('tabs'); setActiveTab('surface'); },
      icon: <svg {...ICON}><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></svg>,
    },
  ];
  return (
    <div className="sfc-chrome__layout" role="group" aria-label={isZh ? 'Surface 放在哪' : 'Surface placement'}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          className={`sfc-chrome__layout-btn${it.on ? ' is-on' : ''}`}
          title={it.label}
          aria-label={it.label}
          aria-pressed={it.on}
          onClick={it.go}
        >
          {it.icon}
        </button>
      ))}
    </div>
  );
};

export default SurfaceLayoutButtons;
