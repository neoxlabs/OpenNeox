import React from 'react';
import { SettingsRow } from './SettingsRow';

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  'aria-label'?: string;
}

/* Slider — 横向 range, 包装 native <input type="range"> + 自定义 track/thumb (settings-base.css).
 *   - 视觉: 4px 灰 track + accent fill + 14px 圆 thumb + 双 hairline
 *   - 键盘 / a11y / 触屏 拖动全部 native 给, 不自造拖拽
 */
export const Slider: React.FC<SliderProps> = ({
  value, min, max, step = 1, onChange, disabled, ...aria
}) => {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className="nx-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      aria-label={aria['aria-label']}
      style={{ ['--nx-slider-pct' as any]: `${pct}%` }}
    />
  );
};

interface SliderRowProps {
  title: React.ReactNode;
  desc?: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  /* 显示在右侧的当前值标签 (如 "1.0x"). 不传就只显纯数字. */
  formatValue?: (v: number) => string;
  disabled?: boolean;
}

/* SliderRow — title/desc + 右侧 (value label + slider) 一体. */
export const SliderRow: React.FC<SliderRowProps> = ({
  title, desc, value, min, max, step, onChange, formatValue, disabled,
}) => (
  <SettingsRow
    title={title}
    desc={desc}
    control={
      <div className="nx-slider-row__control">
        <span className="nx-slider-row__value">
          {formatValue ? formatValue(value) : value}
        </span>
        <Slider
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={onChange}
          disabled={disabled}
          aria-label={typeof title === 'string' ? title : undefined}
        />
      </div>
    }
  />
);
