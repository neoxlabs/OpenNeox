import React from 'react';
import { SettingsRow } from './SettingsRow';
import { Switch } from './Switch';

interface Props {
  title: React.ReactNode;
  desc?: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** title 不是纯字符串时, 由调用方显式给开关一个可读名称 */
  ariaLabel?: string;
  /** 高级项 —— 普通档下整行不渲染。见 state/settingsLevel.ts */
  advanced?: boolean;
  /** 行首图标 (功能行放 <RowIcon />) */
  leading?: React.ReactNode;
  className?: string;
  /** 设置搜索的跳转锚点 (见 SettingsRow.id) */
  id?: string;
}

/* SwitchRow — row + iOS toggle 一体, 最常见 settings 行. */
const textOf = (node: React.ReactNode): string | undefined =>
  typeof node === 'string' ? node : typeof node === 'number' ? String(node) : undefined;

export const SwitchRow: React.FC<Props> = ({ title, desc, checked, onChange, disabled, ariaLabel, advanced, leading, className, id }) => (
  <SettingsRow
    id={id}
    className={className}
    title={title}
    desc={desc}
    advanced={advanced}
    leading={leading}
    control={(
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel ?? textOf(title)}
      />
    )}
  />
);
