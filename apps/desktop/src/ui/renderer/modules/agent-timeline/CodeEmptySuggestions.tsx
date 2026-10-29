/**
 * 首屏空态的顶部 —— 品牌标 + 招呼语 + 一句"怎么开口"。三个模式共用。
 */

import React from 'react';
import { NeoxMarkMotion } from './NeoxMarkMotion';




/* UI 3.0: 一句话问「今天交付什么」—— Neox 卖的是成品, 不是聊天 (设计稿首页) */
function greetingLine(isZh: boolean): string {
  const h = new Date().getHours();
  if (isZh) {
    if (h < 6) return '夜深了，还想交付点什么？';
    if (h < 12) return '早上好，今天想交付什么？';
    if (h < 14) return '中午好，今天想交付什么？';
    if (h < 18) return '下午好，今天想交付什么？';
    return '晚上好，今天想交付什么？';
  }
  if (h < 6) return 'Late night — anything left to deliver?';
  if (h < 12) return 'Good morning — what are we delivering today?';
  if (h < 18) return 'Good afternoon — what are we delivering today?';
  return 'Good evening — what are we delivering today?';
}

/* useCodeEmptyRecent / CodeEmptyBelow (「继续之前的工作」) 已删 —— 左侧栏本来就按
 * 项目/时间列着同一批会话, 首屏再列一遍是同一份数据出现两次, 还把输入框往上挤。 */

export const CodeEmptyTop: React.FC<{
  isZh: boolean;
  projectName: string;
  /** 点项目名 → 在这个位置弹项目菜单 */
  onPickProject?: (anchor: DOMRect) => void;
}> = ({ isZh, projectName, onPickProject }) => (
  <div className="atl-empty-stage__top">
    {/* 空闲态: 球停在右下角轻轻浮 (logo 动效) */}
    <NeoxMarkMotion state="idle" size={72} className="atl-empty-stage__logo atl-empty-stage__logo--clay" title="Neox" />
    <div className="atl-empty-stage__greet">
      <h2 className="atl-empty-stage__title">
        {greetingLine(isZh)}
      </h2>
      {!projectName && (
        <p className="atl-empty-stage__sub">
          {isZh ? 'Neox 会把成品放进「成品架」，随时找得到' : 'Finished work lands on your Shelf — always easy to find'}
        </p>
      )}
      {projectName && (
        <p className="atl-empty-stage__sub">
          {isZh ? '在 ' : 'In '}
          {onPickProject ? (
            <button
              type="button"
              className="atl-empty-stage__accent atl-empty-stage__project"
              title={isZh ? '换个项目' : 'Switch project'}
              onClick={(e) => onPickProject(e.currentTarget.getBoundingClientRect())}
            >{projectName}</button>
          ) : <span className="atl-empty-stage__accent">{projectName}</span>}
          {isZh ? ' 里' : ''}
        </p>
      )}
    </div>
  </div>
);
