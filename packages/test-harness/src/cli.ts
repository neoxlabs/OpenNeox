#!/usr/bin/env node
/**
 * neox-test — product scenario catalog (≠ neox-evals)
 *
 * Quality gate = kind:flow (multi-step journeys). Atoms are secondary.
 *
 *   npm run neox-test -- list --kind flow
 *   npm run neox-test:flows:cli
 *   npm run neox-test:flows:desktop
 */
import { Command } from 'commander';
import { MODULES, ALL_SCENARIOS, listScenarios, scenariosByModule } from './catalog/index.js';
import { runCatalog } from './runners/catalogRunner.js';

const program = new Command();
program
  .name('neox-test')
  .description('Neox product QA · CLI/Desktop flows (journeys) + atoms');

function addFilters(cmd: Command) {
  return cmd
    .option('--module <id>', 'module id prefix')
    .option('--surface <cli|desktop>', 'CLI and Desktop catalogs are separate')
    .option('--tier <smoke|core|nightly|manual>')
    .option('--mode <manual|unit|cdp>')
    .option('--priority <P0|P1|P2>')
    .option('--kind <atom|flow>', 'flow = multi-step quality journeys');
}

addFilters(
  program
    .command('list')
    .description('List scenarios'),
)
  .option('--id <scenarioId>', 'id contains / equals filter')
  .action((opts) => {
  const rows = listScenarios(opts);
  const cliN = rows.filter((s) => s.surface === 'cli').length;
  const deskN = rows.filter((s) => s.surface === 'desktop').length;
  const flowN = rows.filter((s) => (s.kind ?? 'atom') === 'flow').length;
  console.log(`# ${rows.length}  (cli=${cliN} · desktop=${deskN} · flows=${flowN})\n`);
  const by = scenariosByModule();
  for (const mod of MODULES) {
    const list = (by.get(mod.id) || []).filter((s) => rows.includes(s));
    if (!list.length) continue;
    console.log(`## [${mod.surface}] ${mod.id} — ${mod.title} (${list.length})`);
    for (const s of list) {
      const kind = (s.kind ?? 'atom').padEnd(4);
      const combo = s.combo?.length ? `  ⟨${s.combo.slice(0, 4).join('+')}⟩` : '';
      console.log(
        `  ${s.priority.padEnd(2)}  ${kind}  ${s.tier.padEnd(7)}  ${s.id}${combo}\n      ${s.title}`,
      );
    }
    console.log('');
  }
});

program
  .command('modules')
  .description('List module buckets (CLI then Desktop)')
  .action(() => {
    console.log('=== CLI ===');
    for (const m of MODULES.filter((x) => x.surface === 'cli')) {
      const n = ALL_SCENARIOS.filter((s) => s.module === m.id).length;
      console.log(`${m.id.padEnd(24)} ${String(n).padStart(3)}  ${m.title}`);
    }
    console.log('\n=== Desktop ===');
    for (const m of MODULES.filter((x) => x.surface === 'desktop')) {
      const n = ALL_SCENARIOS.filter((s) => s.module === m.id).length;
      console.log(`${m.id.padEnd(24)} ${String(n).padStart(3)}  ${m.title}`);
    }
  });

addFilters(
  program
    .command('checklist')
    .description('Print human QA steps (flows print phases + ui asserts + mustNot)'),
)
  .option('--id <scenarioId>', 'single scenario id')
  .action(async (opts) => {
    const { exitCode } = await runCatalog({
      ...opts,
      checklistOnly: true,
      includeManual: true,
    });
    process.exit(exitCode);
  });

addFilters(
  program
    .command('run')
    .description('Run automated scenarios; print checklist for the rest'),
)
  .option('--id <scenarioId>')
  .option('--cdp <url>', 'CDP endpoint', process.env.NEOX_CDP || 'http://127.0.0.1:41777')
  .option('--workspace <path>', 'workspace for CDP cases', process.env.NEOX_WS)
  .option('--out <dir>', 'report dir', '.tmp-test/neox-test-run')
  .option('--skip-manual', 'do not print manual scenarios')
  .option('--strict', 'release gate: exit 1 on any skip/manual or when nothing ran')
  .action(async (opts) => {
    const { exitCode } = await runCatalog({
      module: opts.module,
      surface: opts.surface,
      tier: opts.tier,
      mode: opts.mode,
      priority: opts.priority,
      kind: opts.kind,
      id: opts.id,
      cdpUrl: opts.cdp,
      workspacePath: opts.workspace,
      outDir: opts.out,
      includeManual: !opts.skipManual,
      strict: !!opts.strict,
    });
    process.exit(exitCode);
  });

program.parse();
