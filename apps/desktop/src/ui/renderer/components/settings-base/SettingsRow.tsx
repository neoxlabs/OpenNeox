import React from 'react';
import { useIsAdvancedLevel } from '../../state/settingsLevel';

interface Props {
  title?: React.ReactNode;
  desc?: React.ReactNode;
  /* 左侧 icon (slot, 16-20px) — 通常省略 */
  leading?: React.ReactNode;
  /* 右侧控件 (Switch / Segmented / Select / Btn / Tag) */
  control?: React.ReactNode;
  /* 整 row 可点击 (跳转 / 触发) — 加 hover/active 视觉 */
  onClick?: () => void;
  /* 完全自定义子内容 — title/desc/control 都不用时塞这里 */
  children?: React.ReactNode;
  className?: string;
  /** 高级项 —— 普通档下整行不渲染 (值照常生效, 只是不显示)。见 state/settingsLevel.ts */
  advanced?: boolean;
  /** 设置搜索的跳转锚点 —— 放在行自己身上, 别在外面包 div (会断掉 .nx-row + .nx-row 的分隔线) */
  id?: string;
}

/* Row 行 — 卡内单元, 透明背景, 靠 hairline 跟兄弟 row 分隔.
 *   - 默认结构 = leading? + (title+desc) + control?
 *   - 也可塞 children 完全自绘 (账户 hero 那种复杂 row)
 *   - 整 row clickable: 加 onClick, 自动出 hover/active 态
 */
export const SettingsRow: React.FC<Props> = ({
  title,
  desc,
  leading,
  control,
  onClick,
  children,
  className,
  advanced,
  id,
}) => {
  const isAdvanced = useIsAdvancedLevel();
  const clickable = typeof onClick === 'function';
  const cls = [
    'nx-row',
    clickable && 'nx-row--clickable',
    className,
  ].filter(Boolean).join(' ');

  const handleKey = clickable
    ? (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick!();
        }
      }
    : undefined;

  if (advanced && !isAdvanced) return null;

  return (
    <div
      id={id}
      className={cls}
      onClick={onClick}
      onKeyDown={handleKey}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      {children ?? (
        <>
          {leading != null && <span className="nx-row__leading">{leading}</span>}
          {(title != null || desc != null) && (
            <span className="nx-row__info">
              {title != null && <span className="nx-row__title">{title}</span>}
              {desc != null && <span className="nx-row__desc">{desc}</span>}
            </span>
          )}
          {control != null && <span className="nx-row__control">{control}</span>}
        </>
      )}
    </div>
  );
};
