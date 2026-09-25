export type {
  ModuleId,
  ModuleMeta,
  Priority,
  RunMode,
  Scenario,
  ScenarioContext,
  ScenarioResult,
  ScenarioStep,
  Surface,
  Tier,
} from './types.js';

export { MODULES, ALL_SCENARIOS, listScenarios, scenariosByModule, cliScenarios, desktopScenarios } from './catalog/index.js';
export type { CatalogFilter } from './catalog/index.js';
export { runCatalog } from './runners/catalogRunner.js';
export { connectDesktopCdp } from './harness/cdp.js';
