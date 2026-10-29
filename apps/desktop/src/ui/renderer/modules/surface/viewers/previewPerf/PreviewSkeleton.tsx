/* 预览首屏骨架 (S-05)。
 *
 * 只做一件事: 打开文件的头一两百毫秒里, 先把「内容将要出现在哪」画出来,
 * 不让用户对着一片空白等解析。骨架刻意画得很轻 (纯 div + CSS 动画),
 * 保证自身渲染成本远低于真正的文档渲染。
 *
 * 无障碍: role=status + aria-busy, 读屏会读出「正在加载」。
 */

import React from 'react';
import './previewSkeleton.css';

export type PreviewSkeletonKind = 'doc' | 'docx' | 'sheet' | 'pptx';

interface Props {
  kind: PreviewSkeletonKind;
  label: string;
}

const LINE_WIDTHS = [92, 78, 86, 64, 90, 72];
const SHEET_COLS = 6;
const SHEET_ROWS = 14;

export const PreviewSkeleton: React.FC<Props> = ({ kind, label }) => {
  return (
    <div className={`sfc-skeleton sfc-skeleton--${kind}`} role="status" aria-busy="true" aria-live="polite">
      <span className="sfc-skeleton__label">{label}</span>
      <div className="sfc-skeleton__body" aria-hidden="true">
        {kind === 'doc' && (
          <div className="sfc-skeleton__doc">
            <div className="sfc-skeleton__bar sfc-skeleton__bar--title" />
            {LINE_WIDTHS.concat(LINE_WIDTHS).map((w, i) => (
              <div key={i} className="sfc-skeleton__bar" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {kind === 'docx' && (
          <div className="sfc-skeleton__page">
            <div className="sfc-skeleton__bar sfc-skeleton__bar--title" />
            {LINE_WIDTHS.map((w, i) => (
              <div key={i} className="sfc-skeleton__bar" style={{ width: `${w}%` }} />
            ))}
            <div className="sfc-skeleton__block" />
            {LINE_WIDTHS.slice(0, 4).map((w, i) => (
              <div key={`b${i}`} className="sfc-skeleton__bar" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {kind === 'sheet' && (
          <div className="sfc-skeleton__grid" style={{ gridTemplateColumns: `repeat(${SHEET_COLS}, 1fr)` }}>
            {Array.from({ length: SHEET_COLS * SHEET_ROWS }).map((_, i) => (
              <div key={i} className={`sfc-skeleton__cell${i < SHEET_COLS ? ' is-head' : ''}`} />
            ))}
          </div>
        )}
        {kind === 'pptx' && (
          <div className="sfc-skeleton__pptx">
            <div className="sfc-skeleton__thumbs">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="sfc-skeleton__thumb" />
              ))}
            </div>
            <div className="sfc-skeleton__stage" />
          </div>
        )}
      </div>
    </div>
  );
};

export default PreviewSkeleton;
