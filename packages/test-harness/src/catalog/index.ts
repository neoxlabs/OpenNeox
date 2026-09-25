import { MODULES } from './modules.js';
import { cliScenarios } from './scenarios/cli/index.js';
import { desktopScenarios } from './scenarios/desktop/index.js';
import type { ModuleId, Scenario, Surface, Tier } from '../types.js';

export { MODULES, cliScenarios, desktopScenarios };

/** Product scenarios only — CLI and Desktop are separate trees. */
export const ALL_SCENARIOS: Scenario[] = [...cliScenarios, ...desktopScenarios];

export type CatalogFilter = {
  module?: ModuleId | string;
  surface?: Surface;
  tier?: Tier;
  priority?: string;
  mode?: string;
  id?: string;
  /** Prefer quality journeys when set to 'flow' */
  kind?: 'atom' | 'flow';
};

export function listScenarios(filter: CatalogFilter = {}): Scenario[] {
  return ALL_SCENARIOS.filter((s) => {
    const kind = s.kind ?? 'atom';
    if (filter.id && s.id !== filter.id && !s.id.includes(filter.id)) return false;
    if (filter.module && s.module !== filter.module && !s.module.startsWith(String(filter.module))) {
      return false;
    }
    if (filter.surface && s.surface !== filter.surface) return false;
    if (filter.tier && s.tier !== filter.tier) return false;
    if (filter.priority && s.priority !== filter.priority) return false;
    if (filter.mode && s.mode !== filter.mode) return false;
    if (filter.kind && kind !== filter.kind) return false;
    return true;
  });
}

export function scenariosByModule(): Map<string, Scenario[]> {
  const map = new Map<string, Scenario[]>();
  for (const s of ALL_SCENARIOS) {
    const list = map.get(s.module) || [];
    list.push(s);
    map.set(s.module, list);
  }
  return map;
}
