import React from 'react';
import { useI18n } from '../../../hooks/useI18n';

/**
 * Work 模式「改了什么」卡 —— 一次文档 / 表格修改, 用人话一条一条列出来。
 *
 *   标签 (哪里改的: 「B9」「改写第 3 段」)  原文 (划掉) → 新内容
 *
 * 不画 diff、不画代码框: 这是给看结果的人的回执, 不是给审代码的人的补丁。
 * 样式在 work-change.css (nx-change 前缀, 独立文件, 不进 agent-timeline.css 的 !important 战场)。
 */
export const ChangeView: React.FC<{
  items: Array<{ label?: string; before?: string; after?: string }>;
  more?: number;
}> = ({ items, more }) => {
  const { isZh } = useI18n();
  return (
    <ul className="nx-change">
      {items.map((it, i) => (
        <li key={i} className="nx-change__item">
          {it.label && <span className="nx-change__label">{it.label}</span>}
          {it.before && <del className="nx-change__before">{it.before}</del>}
          {it.before && it.after && <span className="nx-change__arrow" aria-hidden="true">→</span>}
          {it.after && <span className="nx-change__after">{it.after}</span>}
        </li>
      ))}
      {more ? (
        <li className="nx-change__more">{isZh ? `还有 ${more} 处` : `${more} more`}</li>
      ) : null}
    </ul>
  );
};
