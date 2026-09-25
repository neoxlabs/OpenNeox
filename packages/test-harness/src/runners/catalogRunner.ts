import { resolve } from 'node:path';
import { listScenarios, type CatalogFilter } from '../catalog/index.js';
import { connectDesktopCdp } from '../harness/cdp.js';
import { emptyReport, finishReport, printSummary, pushResult } from '../harness/report.js';
import { formatTokens } from '../harness/usageMeter.js';
import type { Scenario, ScenarioContext } from '../types.js';

export type RunOptions = CatalogFilter & {
  outDir?: string;
  cdpUrl?: string;
  workspacePath?: string;
  /** Include manual scenarios as printed checklist (counted as manual, not fail) */
  includeManual?: boolean;
  /** Only print checklist, do not run unit/cdp */
  checklistOnly?: boolean;
  /**
   * Release-gate mode: any skip or manual scenario, or zero executed scenarios, exits 1.
   * Default (loose) mode only fails on `fail`, so "CDP unreachable → every case skipped" exits 0.
   */
  strict?: boolean;
};

/** Why a strict run must not pass; empty when it may. */
export function strictGateViolations(summary: { pass: number; fail: number; skip: number; manual: number }): string[] {
  const out: string[] = [];
  if (summary.pass + summary.fail === 0) out.push('no scenario was executed');
  if (summary.skip > 0) out.push(`${summary.skip} skipped`);
  if (summary.manual > 0) out.push(`${summary.manual} manual (not verified by this run)`);
  return out;
}

export async function runCatalog(opts: RunOptions = {}): Promise<{ reportPath: string; exitCode: number }> {
  const outDir = opts.outDir || resolve(process.cwd(), '.tmp-test/neox-test-run');
  const scenarios = listScenarios(opts);
  const report = emptyReport({
    module: opts.module,
    surface: opts.surface,
    tier: opts.tier,
    mode: opts.mode,
    id: opts.id,
  });

  let cdp: Awaited<ReturnType<typeof connectDesktopCdp>> | null = null;
  const needsCdp = !opts.checklistOnly && scenarios.some((s) => s.mode === 'cdp' && s.run);
  let cdpUnavailable: string | null = null;

  try {
    if (needsCdp) {
      try {
        cdp = await connectDesktopCdp({
          cdpUrl: opts.cdpUrl,
          outDir,
        });
      } catch (e) {
        cdpUnavailable = e instanceof Error ? e.message : String(e);
        console.log(`CDP unavailable — skipping cdp scenarios (${cdpUnavailable.slice(0, 120)})`);
      }
    }

    for (const scenario of scenarios) {
      if (opts.checklistOnly || scenario.mode === 'manual' || !scenario.run) {
        if (opts.includeManual !== false) {
          printManual(scenario);
          pushResult(report, scenario, 'manual');
        } else {
          pushResult(report, scenario, 'skip', { ok: true, note: 'manual skipped' });
        }
        continue;
      }

      if (scenario.mode === 'cdp' && !cdp) {
        pushResult(report, scenario, 'skip', {
          ok: true,
          note: cdpUnavailable || 'CDP not attached',
        });
        console.log(`SKIP ${scenario.id}  (no CDP)`);
        continue;
      }

      const ctx: ScenarioContext = {
        cdpUrl: opts.cdpUrl || process.env.NEOX_CDP || 'http://127.0.0.1:41777',
        workspacePath: opts.workspacePath || process.env.NEOX_WS,
        outDir,
        page: cdp?.page,
      };

      process.stdout.write(`→ ${scenario.id} … `);
      /* 计时进报告; **token 由用例自己报** (detail.tokens)。
       *
       *   runner 这层试过自动量: 跑前跑后各读一次界面上的「共消耗」再相减。三次都错:
       *     · 每条用例都新建会话 → 前后不是同一个会话的累计, 相减无意义;
       *     · 同一条命令跑两次数字一样 → 差值 0, 报告写成"这条不花钱";
       *     · 补"页脚指纹变没变"的启发式 → 切会话的用例照样被算上一条的账。
       *   页面上那个数只回答"当前显示的是哪一轮", 而"哪一轮属于我"只有用例自己知道。
       *   所以不猜了: 花 token 的用例在自己跑完那一刻调 readUsage 报进 detail.tokens;
       *   不报的就显示 "-"。宁可空着, 也不要编一个数 —— 假的 0 你会直接信。 */
      const startedAt = Date.now();
      try {
        const result = await scenario.run(ctx);
        const status = result.ok ? 'pass' : 'fail';
        const selfReported = (result.detail as Record<string, unknown> | undefined)?.tokens;
        pushResult(report, scenario, status, {
          ...result,
          detail: { ...(result.detail ?? {}), durationMs: Date.now() - startedAt },
        });
        console.log(
          status.toUpperCase() +
            (typeof selfReported === 'number' ? `  (${formatTokens(selfReported)} tok)` : '') +
            (result.note ? ` (${result.note})` : ''),
        );
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        pushResult(report, scenario, 'fail', {
          ok: false,
          error,
          detail: { durationMs: Date.now() - startedAt },
        });
        console.log(`FAIL (${error})`);
      }
    }
  } finally {
    if (cdp) {
      try {
        await cdp.app.close();
      } catch {
        /* ignore */
      }
    }
  }

  const reportPath = finishReport(report, outDir);
  printSummary(report);
  console.log(`report: ${reportPath}`);
  let exitCode = report.summary.fail > 0 ? 1 : 0;
  if (opts.strict) {
    const violations = strictGateViolations(report.summary);
    if (violations.length) {
      console.log(`STRICT GATE FAILED: ${violations.join('; ')}`);
      exitCode = 1;
    }
  }
  return { reportPath, exitCode };
}

function printManual(scenario: Scenario): void {
  const kind = scenario.kind ?? 'atom';
  const head = kind === 'flow' ? 'FLOW' : 'MANUAL';
  console.log(`\n[${head}] ${scenario.id}  ${scenario.title}`);
  console.log(
    `  surface=${scenario.surface}  module=${scenario.module}  pri=${scenario.priority}` +
      (scenario.estimateMin ? `  ~${scenario.estimateMin}min` : ''),
  );
  console.log(`  why: ${scenario.why}`);
  if (scenario.combo?.length) console.log(`  combo: ${scenario.combo.join(' · ')}`);
  if (scenario.codeHint) console.log(`  code: ${scenario.codeHint}`);
  if (scenario.preconditions?.length) {
    console.log('  preconditions:');
    for (const p of scenario.preconditions) console.log(`    - ${p}`);
  }
  if (scenario.mustNot?.length) {
    console.log('  MUST NOT (serious bugs):');
    for (const m of scenario.mustNot) console.log(`    - ${m}`);
  }
  let lastPhase = '';
  for (const [i, step] of scenario.steps.entries()) {
    if (step.phase && step.phase !== lastPhase) {
      lastPhase = step.phase;
      console.log(`  —— ${step.phase} ——`);
    }
    const sev = step.severity ? ` [${step.severity}]` : '';
    console.log(`  ${i + 1}. ${step.action}${sev}`);
    console.log(`     expect: ${step.expect}`);
    if (step.assertUi?.length) {
      for (const a of step.assertUi) {
        if (a.type === 'geometry') console.log(`     ui.geometry: ${a.rule}`);
        else if (a.type === 'order') console.log(`     ui.order: ${a.sequence.join(' → ')}`);
        else if (a.type === 'state') console.log(`     ui.state: ${a.target} = ${a.state}`);
        else if (a.type === 'class')
          console.log(
            `     ui.class: ${a.target}` +
              (a.has ? ` has[${a.has.join(',')}]` : '') +
              (a.missing ? ` missing[${a.missing.join(',')}]` : ''),
          );
        else if (a.type === 'visible') console.log(`     ui.visible: ${a.target}`);
        else if (a.type === 'not_visible') console.log(`     ui.not: ${a.target}`);
        else if (a.type === 'text') console.log(`     ui.text: ${a.target} ~ ${a.matches}`);
      }
    }
  }
}
