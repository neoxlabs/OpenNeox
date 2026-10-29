import React from 'react';

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}

/* iOS-style toggle — Phase 1 唯一统一 switch 控件.
 *   - 26×44 胶囊, white knob, 主色背景表激活态
 *   - data-on="true|false" 让 CSS 控制视觉 (避免 React 类切换闪烁)
 */
export const Switch: React.FC<Props> = ({ checked, onChange, disabled, ...aria }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={aria['aria-label']}
    className="nx-switch"
    data-on={checked ? 'true' : 'false'}
    disabled={disabled}
    onClick={() => !disabled && onChange(!checked)}
  />
);
