/**
 * 当前会话此刻的阶段 (时间线底部状态行 / 跑着的工具组播报共用)。
 * 订阅了时间轴 feed —— 只给「那一行」用, 别挂在每一行上。
 */
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { useTimelineFeed } from '../../state/timelineFeedStore';
import { derivePhase, phaseLabel, type AgentPhase } from './agentPhase';

export function useWaitingPhase(isZh: boolean): { phase: AgentPhase; label: string } {
  const rt = useNeoxRuntimeOptional();
  const events = useTimelineFeed();
  const ph = derivePhase({ streaming: true, approval: !!rt?.pendingApproval, error: false, justDone: false, status: rt?.status, events });
  /* 用在「末行不在动」的地方; feed 比 rows 快一拍, 判成工具 / 正文 / 空闲的那一瞬按思考写 */
  const phase: AgentPhase = ph.phase === 'tool' || ph.phase === 'writing' || ph.phase === 'idle' || ph.phase === 'done' ? 'thinking' : ph.phase;
  return { phase, label: phaseLabel(phase, isZh, ph.detail) };
}
