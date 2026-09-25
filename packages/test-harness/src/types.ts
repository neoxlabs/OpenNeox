/**
 * Product QA catalog types.
 * CLI and Desktop catalogs are separate trees.
 * Prefer **flow** scenarios over atoms.
 */

export type Surface = 'cli' | 'desktop';

export type ModuleId =
  // CLI
  | 'cli.interrupt'
  | 'cli.compact'
  | 'cli.statusline'
  | 'cli.streaming'
  | 'cli.shell'
  | 'cli.byok'
  | 'cli.timeline'
  | 'cli.slash'
  | 'cli.agent-flow'
  | 'cli.auth'
  | 'cli.session'
  | 'cli.artifact'
  // Desktop
  | 'desktop.boot'
  | 'desktop.timeline'
  | 'desktop.approval'
  | 'desktop.compact'
  | 'desktop.session'
  | 'desktop.byok'
  | 'desktop.oauth'
  | 'desktop.surface'
  | 'desktop.plugins'
  | 'desktop.diff'
  | 'desktop.composer'
  | 'desktop.settings'
  | 'desktop.agent-flow'
  | 'desktop.timeline-layout'
  | 'desktop.auth'
  | 'desktop.artifact'
  | 'desktop.cloud';

export type Tier = 'smoke' | 'core' | 'nightly' | 'manual';
export type RunMode = 'manual' | 'unit' | 'cdp';
export type Priority = 'P0' | 'P1' | 'P2';
export type ScenarioKind = 'atom' | 'flow';

export type ScenarioStep = {
  phase?: string;
  action: string;
  expect: string;
  severity?: 'blocker' | 'major' | 'minor';
  assertUi?: UiAssert[];
};

export type UiAssert =
  | { type: 'visible'; target: string; note?: string }
  | { type: 'not_visible'; target: string; note?: string }
  | { type: 'text'; target: string; matches: string; note?: string }
  | { type: 'order'; sequence: string[]; note?: string }
  | { type: 'class'; target: string; has?: string[]; missing?: string[]; note?: string }
  | { type: 'geometry'; rule: string; note?: string }
  | { type: 'state'; target: string; state: string; note?: string };

export type ScenarioResult = {
  ok: boolean;
  note?: string;
  error?: string;
  detail?: Record<string, unknown>;
  failedPhase?: string;
};

export type ScenarioContext = {
  cdpUrl: string;
  workspacePath?: string;
  outDir: string;
  page?: unknown;
};

export type Scenario = {
  id: string;
  module: ModuleId;
  surface: Surface;
  tier: Tier;
  priority: Priority;
  kind?: ScenarioKind;
  title: string;
  why: string;
  mode: RunMode;
  steps: ScenarioStep[];
  combo?: string[];
  preconditions?: string[];
  mustNot?: string[];
  estimateMin?: number;
  codeHint?: string;
  run?: (ctx: ScenarioContext) => Promise<ScenarioResult>;
};

export type ModuleMeta = {
  id: ModuleId;
  surface: Surface;
  title: string;
  description: string;
};
