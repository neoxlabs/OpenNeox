import React from 'react';

export const SubAgentMark: React.FC<{ running?: boolean; size?: number } & React.SVGProps<SVGSVGElement>> = ({
  running, size = 14, ...rest
}) => (
  <svg
    className={`atl-subagent-mark${running ? ' is-running' : ''}`}
    viewBox="0 0 16 16" width={size} height={size}
    {...rest}
  >
    {/* 主节点: 实心 —— 派活的那个 */}
    <circle cx="3.4" cy="8" r="2.4" fill="currentColor" />
    {/* 两条直线分叉 */}
    <path d="M6.1 8h2.2l2 -2.9M6.1 8h2.2l2 2.9"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    {/* 两个子节点: 空心 —— 被派出去的那两个 */}
    <circle cx="12.2" cy="4.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="12.2" cy="11.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
