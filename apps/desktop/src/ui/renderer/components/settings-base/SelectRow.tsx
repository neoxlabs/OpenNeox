import React from 'react';
import { SettingsRow } from './SettingsRow';

interface Option<V extends string> {
  value: V;
  label: React.ReactNode;
}

interface Props<V extends string> {
  title: React.ReactNode;
  desc?: React.ReactNode;
  value: V;
  onChange: (next: V) => void;
  options: Option<V>[];
  disabled?: boolean;
}

/* SelectRow — row + native ▼ chevron select.
 *   - 用原生 <select> 保证键盘 / a11y 不操心
 *   - 视觉: 1px hairline 描边 + 内 4% fg 微染色背景
 *   - chevron 用 inline svg data-url 嵌进 background-image
 */
export function SelectRow<V extends string>({
  title, desc, value, onChange, options, disabled,
}: Props<V>) {
  return (
    <SettingsRow
      title={title}
      desc={desc}
      control={
        <select
          className="nx-select"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as V)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {typeof o.label === 'string' ? o.label : o.value}
            </option>
          ))}
        </select>
      }
    />
  );
}
