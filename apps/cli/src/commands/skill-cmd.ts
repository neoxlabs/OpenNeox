/**
 * neox skill <subcommand>  — K4-MVP CLI lifecycle 命令.
 *
 *   subcommands:
 *     install <url>       下载 SKILL.md, 装到 ~/.neox/skills/, 默认 trustLevel='limited'
 *     update <id>         同 URL 重新拉取, 升级版本 (保留 trustLevel)
 *     uninstall <id>      rm -rf 整个 skill 目录 + 清 .neox-skill.json
 *     list                列已安装 skill 跟其 metadata (trustLevel/source/version)
 *     trust <id>          limited → trusted (允许调任意工具, 跟 builtin/user 同档)
 *     untrust <id>        trusted → limited
 *
 *   跟 desktop Settings Skills tab 走同一个 backend (SkillInstallManager),
 *   一份业务逻辑两个 surface 一致.
 */

import chalk from 'chalk';
import { skillInstallManager } from '@neoxlabs/core/skills/installManager.js';

function printUsage(): void {
  console.log(chalk.cyan('neox skill') + ' <subcommand>');
  console.log('');
  console.log('  ' + chalk.green('install') + '   <url|path>     Install a skill from SKILL.md URL or local path (--yes to skip confirm)');
  console.log('  ' + chalk.green('preview') + '   <url|path>     Show skill metadata (author/version/allowedTools) without installing');
  console.log('  ' + chalk.green('update') + '    <id>           Update an installed skill from its source URL');
  console.log('  ' + chalk.green('uninstall') + ' <id>           Remove an installed skill');
  console.log('  ' + chalk.green('list') + '                     List installed skills');
  console.log('  ' + chalk.green('trust') + '     <id>           Allow this skill to call any tool (uplift from limited)');
  console.log('  ' + chalk.green('untrust') + '   <id>           Restrict this skill to declared allowedTools only');
  console.log('');
  console.log('Default install location: ' + chalk.dim('~/.neox/skills/'));
  console.log('Default trust level on install: ' + chalk.dim('limited') + ' (use `trust` to uplift)');
  console.log('');
  console.log('Examples:');
  console.log('  ' + chalk.dim('neox skill install https://raw.githubusercontent.com/x/y/main/SKILL.md'));
  console.log('  ' + chalk.dim('neox skill install ./my-local-skill/SKILL.md'));
  console.log('  ' + chalk.dim('neox skill preview <url>   # 装之前看清楚 author/allowedTools'));
}

async function cmdPreview(url: string): Promise<number> {
  if (!url) {
    console.error(chalk.red('Error: preview requires a URL or path'));
    return 2;
  }
  const isLocal = url.startsWith('file://') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../');
  const p = isLocal
    ? skillInstallManager.previewLocal(url.startsWith('file://') ? url.slice(7) : url)
    : await skillInstallManager.preview(url);
  if (!p.success) {
    console.error(chalk.red(`✗ Preview failed: ${p.error}`));
    return 1;
  }
  console.log(chalk.cyan('Skill Preview:'));
  console.log(`  ${chalk.bold('Name')}:        ${p.name} (${chalk.dim(p.skillId)})`);
  console.log(`  ${chalk.bold('Version')}:     ${p.version}`);
  console.log(`  ${chalk.bold('Author')}:      ${p.author ?? '(unspecified)'}`);
  console.log(`  ${chalk.bold('Description')}: ${p.description ?? '(none)'}`);
  console.log(`  ${chalk.bold('AllowedTools')}: ${chalk.yellow(p.allowedTools?.length ? p.allowedTools.join(', ') : '(none — a limited skill cannot call any tool)')}`);
  console.log(`  ${chalk.bold('Size')}:        ${p.contentLength} bytes`);
  if (p.bodyPreview) {
    console.log('');
    console.log(chalk.dim('--- Body preview (first 8 lines) ---'));
    console.log(p.bodyPreview);
  }
  console.log('');
  console.log(chalk.dim(`To install: neox skill install ${url}`));
  return 0;
}

async function cmdInstall(url: string, opts: { yes?: boolean } = {}): Promise<number> {
  if (!url) {
    console.error(chalk.red('Error: install requires a URL or local path'));
    console.error('Usage: neox skill install <url|path> [--yes]');
    return 2;
  }
  const isLocal = url.startsWith('file://') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../');

  if (!isLocal && !opts.yes) {
    if (!process.stdin.isTTY) {
      console.error(chalk.red('✗ skill install 非交互模式装远程 URL 需带 --yes (CI 显式信任)'));
      return 1;
    }
    console.log('');
    console.log(chalk.yellow('⚠ 你正在从远程 URL 安装 skill — 它的指令会注入 agent 上下文'));
    console.log(chalk.dim('  仅当你信任来源时才继续. 可先 `neox skill preview <url>` 看清内容.'));
    console.log('');
    console.log(chalk.dim('  URL:      ') + chalk.cyan(url));
    console.log(chalk.dim('  Install:  ') + '~/.neox/skills/');
    console.log('');
    /* skill install 是 CLI 命令行入口 (不在 Ink REPL 内), stdin line mode 可用 readline */
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('继续 install 吗? [y/N]: ').catch(() => '');
    rl.close();
    if (!answer.trim().toLowerCase().startsWith('y')) {
      console.log(chalk.dim('已取消, 未安装. 加 --yes 跳过此 confirm.'));
      return 0;
    }
  }

  console.log(chalk.dim(`${isLocal ? 'Reading' : 'Downloading'} ${url}...`));
  const r = await skillInstallManager.install(url);
  if (!r.success) {
    console.error(chalk.red(`✗ Install failed: ${r.error}`));
    return 1;
  }
  console.log(chalk.green(`✓ Installed '${r.skillId}'`) + (r.meta?.installedVersion ? ` v${r.meta.installedVersion}` : ''));
  console.log(`  source:      ${r.meta?.source.type} (${r.meta?.source.url ?? '(local)'})`);
  console.log(`  trustLevel:  ${chalk.yellow(r.meta?.trustLevel ?? 'limited')}`);
  console.log(`  ${chalk.dim(`Run \`neox skill trust ${r.skillId}\` to allow this skill to call any tool.`)}`);
  return 0;
}

async function cmdUpdate(skillId: string): Promise<number> {
  if (!skillId) {
    console.error(chalk.red('Error: update requires a skill id'));
    return 2;
  }
  console.log(chalk.dim(`Checking ${skillId}...`));
  const r = await skillInstallManager.update(skillId);
  if (!r.success) {
    console.error(chalk.red(`✗ Update failed: ${r.error}`));
    return 1;
  }
  if (r.status === 'up_to_date') {
    console.log(chalk.dim(`✓ Already up-to-date (v${r.previousVersion ?? 'unknown'})`));
  } else {
    console.log(chalk.green(`✓ Updated`) + ` ${r.previousVersion ?? 'unknown'} → ${r.newVersion ?? 'unknown'}`);
  }
  return 0;
}

async function cmdUninstall(skillId: string): Promise<number> {
  if (!skillId) {
    console.error(chalk.red('Error: uninstall requires a skill id'));
    return 2;
  }
  const r = await skillInstallManager.uninstall(skillId);
  if (!r.success) {
    console.error(chalk.red(`✗ Uninstall failed: ${r.error}`));
    return 1;
  }
  console.log(chalk.green(`✓ Removed '${skillId}'`));
  return 0;
}

async function cmdList(): Promise<number> {
  const items = skillInstallManager.listInstalled();
  if (items.length === 0) {
    console.log(chalk.dim('(no installed skills — try `neox skill install <url>`)'));
    return 0;
  }
  /* 表头 + per-skill 一行 */
  console.log(chalk.bold('ID'.padEnd(28)) + chalk.bold('VER'.padEnd(10)) + chalk.bold('TRUST'.padEnd(10)) + chalk.bold('SOURCE'));
  for (const m of items) {
    const trustColor = m.trustLevel === 'trusted' ? chalk.green : chalk.yellow;
    const sourceText = m.source.type === 'local'
      ? `local: ${m.source.path ?? ''}`
      : `${m.source.type}: ${m.source.url ?? ''}`;
    console.log(
      m.skillId.padEnd(28) +
      (m.installedVersion || 'unknown').padEnd(10) +
      trustColor(m.trustLevel.padEnd(10)) +
      chalk.dim(sourceText.slice(0, 80))
    );
  }
  return 0;
}

async function cmdTrust(skillId: string): Promise<number> {
  if (!skillId) {
    console.error(chalk.red('Error: trust requires a skill id'));
    return 2;
  }
  console.log(chalk.yellow(`⚠ This will allow '${skillId}' to call ANY tool (including execute_shell).`));
  /* CLI 是脚本场景, 不弹交互确认 — 用户主动跑命令 = 已确认. Settings UI 那边会弹 modal. */
  const r = await skillInstallManager.trust(skillId);
  if (!r.success) {
    console.error(chalk.red(`✗ Trust failed: ${r.error}`));
    return 1;
  }
  console.log(chalk.green(`✓ '${skillId}' is now trusted`));
  return 0;
}

async function cmdUntrust(skillId: string): Promise<number> {
  if (!skillId) {
    console.error(chalk.red('Error: untrust requires a skill id'));
    return 2;
  }
  const r = await skillInstallManager.untrust(skillId);
  if (!r.success) {
    console.error(chalk.red(`✗ Untrust failed: ${r.error}`));
    return 1;
  }
  console.log(chalk.green(`✓ '${skillId}' is now limited (only allowedTools permitted)`));
  return 0;
}

export async function handleSkillCliCommand(args: string[]): Promise<number> {
  /* --yes / -y: 跳过 install 的远程 URL confirm (CI / 脚本用), 从 positional 里剥掉 */
  const yes = args.includes('--yes') || args.includes('-y');
  const positional = args.filter((a) => a !== '--yes' && a !== '-y');
  const sub = positional[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printUsage();
    return 0;
  }
  switch (sub) {
    case 'install':   return cmdInstall(positional[1], { yes });
    case 'preview':   return cmdPreview(positional[1]);
    case 'update':    return cmdUpdate(positional[1]);
    case 'uninstall': return cmdUninstall(positional[1]);
    case 'list':      return cmdList();
    case 'trust':     return cmdTrust(positional[1]);
    case 'untrust':   return cmdUntrust(positional[1]);
    default:
      console.error(chalk.red(`Unknown subcommand: ${sub}`));
      printUsage();
      return 2;
  }
}
