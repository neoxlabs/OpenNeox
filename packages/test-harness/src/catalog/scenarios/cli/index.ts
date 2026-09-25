import type { Scenario } from '../../types.js';
import { interrupt } from './interrupt.js';
import { compact } from './compact.js';
import { statusline, streaming, shell } from './status-stream-shell.js';
import { byok, timeline, slash } from './byok-timeline-slash.js';
import { agentFlows } from './agent-flows.js';
import { cliMatrixFlows } from './matrix-flows.js';
import { cliCapabilityFlows } from './capability-flows.js';

/** CLI only — flows/capabilities first, then atoms. */
export const cliScenarios: Scenario[] = [
  ...cliCapabilityFlows,
  ...agentFlows,
  ...cliMatrixFlows,
  ...interrupt,
  ...compact,
  ...statusline,
  ...streaming,
  ...shell,
  ...byok,
  ...timeline,
  ...slash,
];
