import React from 'react';

interface Option<V extends string> {
  value: V;
  label: React.ReactNode;
}

interface Props<V extends string> {
  value: V;
  onChange: (next: V) => void;
  options: Option<V>[];
  disabled?: boolean;
  'aria-label'?: string;
}

/* Segmented — 2/3/N 选 1 的胶囊切换 (macOS 控件 / GeneralTab 中英文/Off-On 类用法).
 *   - 选中态 knob (background:bg-card + 1px shadow) 在胶囊轨道里
 *   - 跟 RadioCard 不同: Segmented 是行内紧凑控件, RadioCard 是大卡
 */
export function Segmented<V extends string>({
  value, onChange, options, disabled, ...aria
}: Props<V>) {
  return (
    <div
      role="tablist"
      aria-label={aria['aria-label']}
      className="nx-segmented"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          className="nx-segmented__btn"
          data-on={value === opt.value ? 'true' : 'false'}
          disabled={disabled}
          onClick={() => !disabled && onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
