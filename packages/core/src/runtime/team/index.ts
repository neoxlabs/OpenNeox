/**
 * Team 模块导出 (Team P2 — TEAM_MODE_DESIGN)
 */


export {
  validateTeamRun,
  estimateLaneMinutes,
  TEAM_LANE_ROLES,
  MAX_TEAM_LANES,
  MIN_TEAM_LANES,
  MIN_LANE_MINUTES,
  MIN_TEAM_TOTAL_MINUTES,
  MAX_TEAM_MILESTONES,
} from './teamRunValidator.js';
export type {
  TeamLaneRole,
  TeamLaneInput,
  TeamMilestoneInput,
  TeamRunInput,
  NormalizedTeamLane,
  TeamMilestone,
  TeamRunValidation,
  TeamRunViolation,
} from './teamRunValidator.js';

export { TeamBlackboard, parseBlackboardJson } from './teamBlackboard.js';
export type { TeamBlackboardEntry } from './teamBlackboard.js';
