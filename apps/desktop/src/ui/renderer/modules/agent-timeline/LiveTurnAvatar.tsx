/**
 * 正在跑的这一轮左边那枚会动的标 —— 位置跟跑完后折叠行的静态头像同一处 (见 liveTurnMark.ts)。
 * 等审批时球改成「敲」: 审批状态只在 runtime 里, rows 看不到。
 */
import React from 'react';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { NeoxMarkMotion, type NeoxMarkState } from './NeoxMarkMotion';

export const LiveTurnAvatar: React.FC<{ state: NeoxMarkState }> = ({ state }) => {
  const rt = useNeoxRuntimeOptional();
  const s: NeoxMarkState = rt?.pendingApproval ? 'wait' : state;
  return <span className="atl-live-avatar"><NeoxMarkMotion state={s} size={30} /></span>;
};

export default LiveTurnAvatar;
