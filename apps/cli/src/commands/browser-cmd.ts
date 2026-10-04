
import chalk from 'chalk';

export async function handleBrowserCliCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? '';
  const wantJson = args.includes('--json');
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return 0;
  }

  /* 动态 import: 这些模块会拉起浏览器管理器, 别让每次 `neox --help` 都加载它们 */
  const { listRecipes } = await import('@neoxlabs/core/tools/runtimeTools.js');

  if (sub === 'ls' || sub === 'list') {
    const all = listRecipes();
    if (wantJson) { console.log(JSON.stringify(all)); return 0; }
    if (!all.length) {
      console.log(`\n  ${chalk.gray('•')} 还没有录过。让 agent 做一次网页任务时在 browser_run 里加 record:"名字"。\n`);
      return 0;
    }
    console.log('');
    for (const r of all) {
      console.log(`  ${chalk.bold(r.name.padEnd(28))} ${String(r.steps).padStart(3)} 步   ${chalk.gray(r.updatedAt.slice(0, 19).replace('T', ' '))}   ${chalk.gray(r.description)}`);
    }
    console.log('');
    return 0;
  }

  if (sub === 'replay' || sub === 'run') {
    const rest = args.slice(1).filter((a) => a !== '--json');
    const tIdx = rest.indexOf('--timeout');
    const timeoutMs = tIdx >= 0 ? Number(rest[tIdx + 1]) || undefined : undefined;
    if (tIdx >= 0) rest.splice(tIdx, 2);
    const all = rest.includes('--all') || rest.includes('*');
    const names = rest.filter((a) => !a.startsWith('--') && a !== '*');
    if (!all && !names.length) {
      console.error(`  ${chalk.red('✗')} 要跑哪条? neox browser replay <name> 或 --all`);
      return 2;
    }

    const { replayAll, BROWSER_INSTRUCTION_SET } = await import('@neoxlabs/core/tools/runtimeTools.js');

    const report = await replayAll(BROWSER_INSTRUCTION_SET, { timeoutMs, names: all ? undefined : names });
    if (wantJson) {
      console.log(JSON.stringify(report));
    } else {
      console.log('');
      for (const row of report.rows) {
        const mark = row.ok ? chalk.green('✓') : chalk.red('✗');
        const where = row.ok ? '' : chalk.red(`  第 ${row.failedAt ?? '?'} 步: ${row.error ?? ''}`);
        const healed = row.healed ? chalk.yellow(`  (自愈 ${row.healed} 步, 已写回)`) : '';
        console.log(`  ${mark} ${row.name.padEnd(28)} ${String(row.ranSteps).padStart(3)}/${String(row.steps).padEnd(3)} 步 ${String(row.ms).padStart(6)}ms${healed}${where}`);
        if (!row.ok && row.page) console.log(`      ${chalk.gray('页面: ' + row.page)}`);
      }
      console.log('');
      const summary = `${report.passed}/${report.total} 通过 · ${report.totalMs}ms · 0 次模型往返`;
      console.log(`  ${report.ok ? chalk.green(summary) : chalk.red(summary)}\n`);
    }
    /* 浏览器连接会把事件循环拖住 —— 表打完就走, 退出码就是测试结果 */
    const code = report.total === 0 ? 2 : (report.ok ? 0 : 1);
    setTimeout(() => process.exit(code), 50);
    return code;
  }

  console.error(`  ${chalk.red('✗')} 未知子命令 "${sub}"。`);
  printHelp();
  return 2;
}

function printHelp(): void {
  console.log(`
  neox browser ls                    列出录过的浏览器脚本
  neox browser replay <name>         复跑一条录制 (0 次模型往返, 选择器漂了会自愈并写回)
  neox browser replay --all          全部复跑, 出通过表 —— 当回归测试用; 退出码 0=全过 1=有失败
     --json                          机器可读输出
     --timeout <ms>                  每条脚本的总时限 (默认 60000)

  录制: 让 agent 做一次网页任务时在 browser_run 里加 record:"名字"; 脚本结尾用 expect 断言结果,
        录下来的就是带断言的测试用例。
`);
}
