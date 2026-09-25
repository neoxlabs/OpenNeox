import type {
  ModuleId,
  Priority,
  Scenario,
  ScenarioStep,
  Surface,
  Tier,
  UiAssert,
} from '../../types.js';

export type FlowSeed = {
  id: string;
  module: ModuleId;
  surface: Surface;
  title: string;
  why: string;
  combo: string[];
  preconditions?: string[];
  mustNot: string[];
  steps: ScenarioStep[];
  priority?: Priority;
  tier?: Tier;
  estimateMin?: number;
  codeHint?: string;
};

export function flow(seed: FlowSeed): Scenario {
  return {
    id: seed.id,
    module: seed.module,
    surface: seed.surface,
    tier: seed.tier ?? 'core',
    priority: seed.priority ?? 'P0',
    kind: 'flow',
    title: seed.title,
    why: seed.why,
    mode: 'manual',
    steps: seed.steps,
    combo: seed.combo,
    preconditions: seed.preconditions,
    mustNot: seed.mustNot,
    estimateMin: seed.estimateMin ?? 8,
    codeHint: seed.codeHint,
  };
}

export function phase(
  name: string,
  action: string,
  expect: string,
  opts?: {
    severity?: ScenarioStep['severity'];
    assertUi?: UiAssert[];
  },
): ScenarioStep {
  return {
    phase: name,
    action,
    expect,
    severity: opts?.severity ?? 'blocker',
    assertUi: opts?.assertUi,
  };
}

/** Cartesian product helper */
export function cart<T extends unknown[]>(...dims: { [K in keyof T]: T[K][] }): T[] {
  return dims.reduce<unknown[][]>(
    (acc, dim) => {
      const next: unknown[][] = [];
      for (const row of acc) {
        for (const v of dim as unknown[]) next.push([...row, v]);
      }
      return next;
    },
    [[]],
  ) as T[];
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}
