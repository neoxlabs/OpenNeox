/**
 * Shared types for the project startup / DumbService state machine.
 *
 * Lives in `src/shared/` so both main (ProjectStartupCoordinator) and renderer
 * (DumbModeContext) can import the same definitions, avoiding drift.
 */

export type ProjectStartupPhase =
  | 'opening'
  | 'interactive'
  | 'scanning'
  | 'smart'
  | 'enriching'
  | 'ready'
  | 'failed';

export type ProjectStartupTaskState = 'idle' | 'running' | 'ready' | 'failed';

export interface ProjectStartupStatus {
  phase: ProjectStartupPhase;
  rendererReady: boolean;
  started: boolean;
  completed: boolean;
  semantic: ProjectStartupTaskState;
  embedding: ProjectStartupTaskState;
  error: string | null;
}

/**
 * IntelliJ-style coarse state: `dumb` = index still building, features
 * should degrade; `smart` = semantic layer ready, full features; `failed`
 * = bootstrap failed, UI should prompt user to rebuild index.
 */
export type DumbAwareState = 'dumb' | 'smart' | 'failed';

const DUMB_PHASE_LIST: readonly ProjectStartupPhase[] = ['opening', 'interactive', 'scanning'];
const SMART_PHASE_LIST: readonly ProjectStartupPhase[] = ['smart', 'enriching', 'ready'];

export const DUMB_PHASES: ReadonlySet<ProjectStartupPhase> = new Set(DUMB_PHASE_LIST);
export const SMART_PHASES: ReadonlySet<ProjectStartupPhase> = new Set(SMART_PHASE_LIST);

export function isDumbPhase(phase: ProjectStartupPhase): boolean {
  return DUMB_PHASES.has(phase);
}
export function isSmartPhase(phase: ProjectStartupPhase): boolean {
  return SMART_PHASES.has(phase);
}
export function classifyPhase(phase: ProjectStartupPhase): DumbAwareState {
  if (phase === 'failed') return 'failed';
  return isSmartPhase(phase) ? 'smart' : 'dumb';
}

export const INITIAL_PROJECT_STARTUP_STATUS: ProjectStartupStatus = {
  phase: 'opening',
  rendererReady: false,
  started: false,
  completed: false,
  semantic: 'idle',
  embedding: 'idle',
  error: null,
};
