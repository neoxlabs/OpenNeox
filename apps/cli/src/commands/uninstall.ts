
import chalk from 'chalk';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

interface UninstallPath {
  path: string;
  desc: string;
  category: 'cred' | 'config' | 'history' | 'logs' | 'cache' | 'sock';
}

function listUserPaths(): UninstallPath[] {
  const home = os.homedir();
  const neoxDir = path.join(home, NEOX_HOME_DIRNAME);
  const desktopDir = path.join(home, 'Library', 'Application Support', 'Neox');
  const winDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'Neox') : null;
  const linuxConfig = path.join(home, '.config', 'Neox');

  const result: UninstallPath[] = [];

  // 凭据 (高敏感 — 即使 --keep-data 也要清)
  result.push(
    { path: path.join(neoxDir, 'auth.enc'), desc: 'CLI 登录 token', category: 'cred' },
    { path: path.join(neoxDir, 'gateway-key.enc'), desc: 'CLI 网关密钥', category: 'cred' },
    { path: path.join(neoxDir, 'machine-id'), desc: '设备指纹', category: 'cred' },
    { path: path.join(desktopDir, 'auth.enc'), desc: '桌面登录 token', category: 'cred' },
    { path: path.join(desktopDir, 'gateway-key.enc'), desc: '桌面网关密钥', category: 'cred' },
  );

  // 配置
  result.push(
    { path: path.join(neoxDir, 'config.json'), desc: '配置 (provider/model)', category: 'config' },
    { path: path.join(neoxDir, 'routing.json'), desc: '路由配置', category: 'config' },
    { path: path.join(neoxDir, 'users'), desc: '多用户隔离配置 / DB', category: 'config' },
  );

  // 历史 / 数据
  result.push(
    { path: path.join(neoxDir, 'neox.db'), desc: 'SQLite (会话/消息/cost)', category: 'history' },
    { path: path.join(neoxDir, 'neox.db-journal'), desc: 'SQLite journal', category: 'history' },
    { path: path.join(neoxDir, 'neox.db-wal'), desc: 'SQLite WAL', category: 'history' },
    { path: path.join(neoxDir, 'neox.db-shm'), desc: 'SQLite shared mem', category: 'history' },
    { path: path.join(neoxDir, 'sessions'), desc: '旧版会话 JSON', category: 'history' },
    { path: path.join(desktopDir, 'pets'), desc: '桌宠模型', category: 'history' },
    { path: path.join(desktopDir, 'pet-renderers'), desc: '桌宠渲染器', category: 'history' },
    { path: path.join(desktopDir, 'embeddings'), desc: '本地 embedding 缓存', category: 'cache' },
    { path: path.join(desktopDir, 'install.id'), desc: '桌面安装 ID', category: 'config' },
  );

  // 日志 + 临时文件
  result.push(
    { path: path.join(neoxDir, 'logs'), desc: 'CLI 日志 (7d 轮转)', category: 'logs' },
    { path: path.join(neoxDir, 'tasks'), desc: '后台任务输出日志', category: 'logs' },
    { path: path.join(neoxDir, 'command-helper.sock'), desc: 'legacy helper daemon socket', category: 'sock' },
    { path: path.join(neoxDir, 'command-helper.meta.json'), desc: 'legacy helper daemon meta', category: 'sock' },
  );

  // Linux / Windows 桌面 userData (best effort)
  if (winDir) {
    result.push({ path: winDir, desc: 'Windows 桌面 userData', category: 'config' });
  }
  result.push({ path: linuxConfig, desc: 'Linux 桌面 userData', category: 'config' });

  return result;
}

function safeRm(target: string, dryRun: boolean): { ok: boolean; existed: boolean; err?: string } {
  try {
    if (!fs.existsSync(target)) return { ok: true, existed: false };
    if (dryRun) return { ok: true, existed: true };
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true, existed: true };
  } catch (e: any) {
    return { ok: false, existed: true, err: e?.message || String(e) };
  }
}

async function killHelperDaemon(): Promise<void> {
  const sockPath = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'command-helper.sock');
  if (!fs.existsSync(sockPath)) return;
  try {
    const net = await import('net');
    await new Promise<void>((resolve) => {
      const sock = net.createConnection(sockPath);
      let done = false;
      const finish = () => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(); };
      sock.once('connect', () => {
        try { sock.write(`${JSON.stringify({ type: 'shutdown' })}\n`); } catch {}
        setTimeout(finish, 200);
      });
      sock.once('error', finish);
      setTimeout(finish, 1000);
    });
  } catch {
    // best effort
  }
}

async function promptUser(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function printUninstallHelp(): void {
  console.log(`\n${chalk.bold('neox uninstall')} — 清理 Neox 本地用户数据\n`);
  console.log('Usage:');
  console.log(`  neox uninstall              ${chalk.gray('交互式选择')}`);
  console.log(`  neox uninstall --keep-data  ${chalk.gray('仅删凭据 (auth.enc + gateway-key.enc)')}`);
  console.log(`  neox uninstall --all        ${chalk.gray('完全清除 (含历史会话 / 日志 / 配置)')}`);
  console.log(`  neox uninstall --dry-run    ${chalk.gray('预览将删的路径, 不真删')}`);
  console.log('');
  console.log(chalk.gray('  ⚠️ 这只清 user-data, 不会删 binary.'));
  console.log(chalk.gray('     完整卸载 = neox uninstall --all  +  npm uninstall -g @neoxlabs/cli'));
  console.log('');
}

export async function handleUninstallCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    printUninstallHelp();
    return 0;
  }

  let mode: 'keep-data' | 'all' | 'cancel' = 'keep-data';
  const dryRun = args.includes('--dry-run') || args.includes('-n');

  if (args.includes('--all')) {
    mode = 'all';
  } else if (args.includes('--keep-data')) {
    mode = 'keep-data';
  } else if (process.stdin.isTTY) {
    console.log('');
    console.log(`  ${chalk.bold('Neox 卸载向导')}`);
    console.log('');
    console.log(`  ${chalk.gray('1)')} 仅清凭据 (auth.enc, gateway-key.enc) — 保留历史 / 配置`);
    console.log(`  ${chalk.gray('2)')} 完全清除 — 含历史会话 / 日志 / 配置 (${chalk.yellow('不可恢复')})`);
    console.log(`  ${chalk.gray('3)')} 取消`);
    console.log('');
    const choice = await promptUser(`  ${chalk.gray('选择 [1/2/3]:')} `);
    if (choice === '2') mode = 'all';
    else if (choice === '3' || choice === '') mode = 'cancel';
    else mode = 'keep-data';
  }

  if (mode === 'cancel') {
    console.log(`\n  ${chalk.gray('已取消, 没动任何文件.')}\n`);
    return 0;
  }

  console.log('');
  if (dryRun) console.log(chalk.cyan('  [DRY RUN] 预览模式 — 不会真删\n'));

  // 第一步: 杀 daemon (让 helper socket / DB lock 释放)
  if (!dryRun) {
    process.stdout.write(`  ${chalk.gray('▸')} 通知 helper daemon 下线... `);
    await killHelperDaemon();
    console.log(chalk.green('✓'));
  }

  // 第二步: 按 mode 选目标
  const allPaths = listUserPaths();
  const targets = mode === 'all'
    ? allPaths
    : allPaths.filter((p) => p.category === 'cred' || p.category === 'sock');

  let cleaned = 0;
  let missing = 0;
  let errors = 0;

  for (const item of targets) {
    const result = safeRm(item.path, dryRun);
    if (!result.existed) {
      missing++;
      continue;
    }
    if (!result.ok) {
      errors++;
      console.log(`  ${chalk.red('✗')} ${item.desc.padEnd(28)} ${chalk.gray(item.path)}`);
      console.log(`    ${chalk.red(result.err)}`);
      continue;
    }
    cleaned++;
    const tag = dryRun ? chalk.cyan('[would delete]') : chalk.green('✓');
    console.log(`  ${tag} ${item.desc.padEnd(28)} ${chalk.gray(item.path)}`);
  }

  console.log('');
  if (dryRun) {
    console.log(`  ${chalk.cyan(`${cleaned}`)} 项将被删除 · ${chalk.gray(`${missing} 已不存在`)} · ${errors > 0 ? chalk.red(`${errors} 失败`) : '0 失败'}`);
  } else {
    console.log(`  ${chalk.green(`${cleaned}`)} 项已清理 · ${chalk.gray(`${missing} 已不存在`)} · ${errors > 0 ? chalk.red(`${errors} 失败`) : '0 失败'}`);
  }
  console.log('');

  if (mode === 'keep-data' && !dryRun) {
    console.log(chalk.gray('  历史会话 / 配置 / 日志已保留, 重新登录后接着用.'));
  } else if (mode === 'all' && !dryRun) {
    console.log(chalk.gray('  所有 Neox 本地数据已清除. 完整卸载请继续:'));
    console.log(chalk.gray('    npm uninstall -g @neoxlabs/cli'));
    console.log(chalk.gray('    桌面端: 拖 Neox.app → Trash'));
  }
  console.log('');

  return errors > 0 ? 1 : 0;
}
