import React from 'react';

interface Option<V extends string> {
  value: V;
  title: React.ReactNode;
  desc?: React.ReactNode;
  icon?: React.ReactNode;
}

interface Props<V extends string> {
  value: V;
  onChange: (next: V) => void;
  options: Option<V>[];
  columns?: number;
  className?: string;
}

/* RadioCard — N 张大卡 N 选 1 (Codex "For coding / For everyday work" 那种).
 *   - 默认 2 列, 可经 columns 改
 *   - 选中态: primary border + 软发光 + 右侧 radio dot
 *   - 比 Segmented 更"展览"感, 适合 onboarding / 重要选项 / 模板切换
 */
export function RadioCard<V extends string>({
  value, onChange, options, columns = 2, className,
}: Props<V>) {
  const cls = ['nx-radio-group', className].filter(Boolean).join(' ');
  return (
    <div
      role="radiogroup"
      className={cls}
      style={{ ['--nx-radio-cols' as any]: String(columns) }}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className="nx-radio-card"
          data-on={value === opt.value ? 'true' : 'false'}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon != null && <span className="nx-radio-card__icon">{opt.icon}</span>}
          <span className="nx-radio-card__body">
            <span className="nx-radio-card__title">{opt.title}</span>
            {opt.desc != null && <span className="nx-radio-card__desc">{opt.desc}</span>}
          </span>
          <span className="nx-radio-card__dot" aria-hidden />
        </button>
      ))}
    </div>
  );
}
