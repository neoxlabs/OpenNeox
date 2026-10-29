import React from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface Props extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: React.ReactNode;
  variant?: Variant;
  size?: Size;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}

/* NeoxButton — Phase 1 唯一按钮原子, 4 variant × 3 size.
 *   - primary: 实心主色 (登录, 主 CTA)
 *   - secondary: 6% fg 染色 + 1px hairline (次按钮)
 *   - ghost: 透明 + hover (Toolbar / 列表行右侧)
 *   - danger: err 描边 (退出登录, 删除)
 */
export const NeoxButton: React.FC<Props> = ({
  children,
  variant = 'secondary',
  size = 'md',
  leading,
  trailing,
  className,
  ...rest
}) => {
  const cls = [
    'nx-btn',
    `nx-btn--${variant}`,
    size !== 'md' && `nx-btn--${size}`,
    className,
  ].filter(Boolean).join(' ');
  return (
    <button type="button" {...rest} className={cls}>
      {leading}
      {children}
      {trailing}
    </button>
  );
};
