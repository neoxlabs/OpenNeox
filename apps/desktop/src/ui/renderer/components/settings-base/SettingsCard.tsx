import React from 'react';

type Material = 'thin' | 'regular' | 'thick';

interface Props {
  children: React.ReactNode;
  material?: Material;
  className?: string;
}

/* Card 容器 — 设置共享卡.
 *   material 仍透传 neox-material--*, 但 settings-soft.css 会把 regular/thin
 *   统一成 Cursor 风极浅软灰（无 blur / 无重阴影）. thick 保留轻强调底.
 */
export const SettingsCard: React.FC<Props> = ({
  children,
  material = 'regular',
  className,
}) => {
  const cls = [
    'nx-card',
    'neox-material',
    `neox-material--${material}`,
    className,
  ].filter(Boolean).join(' ');
  return <div className={cls}>{children}</div>;
};
