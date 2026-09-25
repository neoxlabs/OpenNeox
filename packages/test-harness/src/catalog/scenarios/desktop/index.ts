import type { Scenario } from '../../types.js';
import { boot, timeline, approval } from './boot-timeline-approval.js';
import { compact, session, byok, oauth } from './compact-session-byok-oauth.js';
import {
  surface,
  plugins,
  diff,
  composer,
  settings,
} from './surface-plugins-diff-composer.js';
import { agentFlows } from './agent-flows.js';
import { timelineLayoutFlows } from './timeline-layout-flows.js';
import { desktopCapabilityFlows } from './capability-flows.js';
import { desktopMatrixFlows } from './matrix-flows.js';
import { approvalSessionIsolation } from './approval-session-isolation.js';

/** Desktop only — capabilities/flows first. */
export const desktopScenarios: Scenario[] = [
  ...desktopCapabilityFlows,
  ...desktopMatrixFlows,
  ...agentFlows,
  ...approvalSessionIsolation,
  ...timelineLayoutFlows,
  ...boot,
  ...timeline,
  ...approval,
  ...compact,
  ...session,
  ...byok,
  ...oauth,
  ...surface,
  ...plugins,
  ...diff,
  ...composer,
  ...settings,
];
