import React from 'react';
import { useIsAdvancedLevel } from '../../state/settingsLevel';

interface Props {
  title: React.ReactNode;
  desc?: React.ReactNode;
  className?: string;
}

/* SectionTitle — 一个 section 上方的 18/600 标题 + 13 灰描述.
 *   通常跟 <SettingsCard> 一对一, 配合 <Section> wrapper 给底部留 28px (--nx-space-5).
 */
export const SectionTitle: React.FC<Props> = ({ title, desc, className }) => {
  const cls = ['nx-section-title', className].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <h3 className="nx-section-title__title">{title}</h3>
      {desc != null && <p className="nx-section-title__desc">{desc}</p>}
    </div>
  );
};

/* Section — 上面 SectionTitle + 下面 Card 的间距 wrapper.
 *   完全可选; 自己控间距时直接堆 SectionTitle + Card 也行. */
export const Section: React.FC<{
  children: React.ReactNode;
  className?: string;
  /** 整段都是高级内容 —— 普通档下连标题带卡片一起不渲染。见 state/settingsLevel.ts */
  advanced?: boolean;
}> = ({ children, className, advanced }) => {
  const isAdvanced = useIsAdvancedLevel();
  if (advanced && !isAdvanced) return null;
  const cls = ['nx-section', className].filter(Boolean).join(' ');
  return <div className={cls}>{children}</div>;
};

/* PageTitle — 整页 page 顶 26/700 标题 + 13 灰副标. */
export const PageTitle: React.FC<{
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  className?: string;
  /** 二级页: 标题左边出「‹ 上一级名字」, 点了回首页 */
  back?: { label: React.ReactNode; onBack: () => void };
}> = ({ title, subtitle, className, back }) => {
  const cls = ['nx-page-title', className].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      {back && (
        <button type="button" className="nx-page-title__back" onClick={back.onBack}>
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
          {back.label}
        </button>
      )}
      <h1 className="nx-page-title__title">{title}</h1>
      {subtitle != null && <p className="nx-page-title__subtitle">{subtitle}</p>}
    </div>
  );
};
