import chalk from 'chalk';
import { loadConfig, CONFIG_FILE, type ProviderProtocol } from '@neoxlabs/platform/utils/config.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import { PROVIDER_BASE_URLS } from '../constants.js';
import { L } from '../i18n/index.js';
import { getCliEdition } from '../edition/index.js';

function printUsage(): void {
  console.log(L(`
用法: neox provider <command>

命令:
  ls, list           列出已配置的 provider
  add                交互式添加 BYOK provider
  test [id]          测试 provider key 连通性
  edit / remove /    交互式管理请在 REPL 内进行:
  use / default        neox → /provider edit <id> 等

示例:`, `
Usage: neox provider <command>

Commands:
  ls, list           List configured providers
  add                Add a bring-your-own-key provider interactively
  test [id]          Test a provider key against its API
  edit / remove /    Manage interactively in the REPL:
  use / default        neox → /provider edit <id> etc.

Examples:`) + `
  neox provider ls
  neox provider add
  neox provider test openai
`);
}

function maskKey(key?: string): string {
  if (!key || !key.trim()) return chalk.red('missing');
  const t = key.trim();
  if (t.length <= 8) return chalk.green('set');
  return chalk.green(`${t.slice(0, 4)}…${t.slice(-4)}`);
}

async function listProviders(): Promise<number> {
  const config = loadConfig();
  const store = new ProviderStore(config);
  const providers = store.getProviders();
  const defaultId = store.getDefaultProvider()?.id;

  if (providers.length === 0) {
    console.log('');
    console.log(chalk.yellow(L('  尚未配置任何 provider', '  No providers yet')));
    console.log('');
    /* 没有账号体系的构建 (开源版) 只有自带 Key 这一条路, 别提 neox login */
    if (getCliEdition().account) {
      console.log(chalk.cyan(L('  两种方式开始:', '  Two ways to start:')));
      console.log(chalk.dim('    ') + chalk.bold('neox login') + chalk.dim(L('          # NeoxCloud 订阅, 多模型零配置', '          # NeoxCloud subscription, many models, no setup')));
      console.log(chalk.dim('    ') + chalk.bold('neox provider add') + chalk.dim(L('   # BYOK 用自己的 API key', '   # bring your own API key')));
    } else {
      console.log(chalk.cyan(L('  添加你自己的 API key 就能用:', '  Add your own API key to get started:')));
      console.log(chalk.dim('    ') + chalk.bold('neox provider add') + chalk.dim(L('   # 交互式向导: 选服务商, 填 key', '   # interactive: pick a provider, paste a key')));
      console.log(chalk.dim('    ') + chalk.bold('export ANTHROPIC_API_KEY=...') + chalk.dim(L('   # 或者设环境变量 (OPENAI / GEMINI / DEEPSEEK ...)', '   # or set an env var (OPENAI / GEMINI / DEEPSEEK ...)')));
    }
    console.log('');
    return 0;
  }

  console.log('');
  for (const p of providers) {
    const isDefault = p.id === defaultId;
    const mark = isDefault ? chalk.green(' (default)') : '';
    console.log(`  ${chalk.bold(p.id)}${mark}`);
    console.log(chalk.dim(`    name: ${p.name} · protocol: ${p.protocol} · key: `) + maskKey(p.apiKey));
    if (p.baseUrl) console.log(chalk.dim(`    baseUrl: ${p.baseUrl}`));
    const model = (p as any).lastSelectedModel ?? p.defaultModel;
    if (model) console.log(chalk.dim(`    model: ${model}`));
    console.log('');
  }
  console.log(chalk.dim(`  config: ${CONFIG_FILE}`));
  console.log('');
  return 0;
}

async function addProvider(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(L('Error: `neox provider add` 是交互式向导, 需要 TTY。\n', 'Error: `neox provider add` is an interactive wizard and needs a TTY.\n'));
    const orLogin = getCliEdition().account ? L(' 或 `neox login`', ' or `neox login`') : '';
    process.stderr.write(L(`  管道/CI 环境请改用环境变量 (如 export OPENAI_API_KEY=sk-...)${orLogin}。\n`,
      `  In pipes/CI use environment variables (e.g. export OPENAI_API_KEY=sk-...)${orLogin}.\n`));
    return 1;
  }

  /* 复用首启引导同一套 Ink 向导 + save 逻辑 (ensureProviderConfigured 的 manual 路径) */
  const { runInkInteractiveSetup } = await import('../provider/providerSetupUI.js');
  const result = await runInkInteractiveSetup();
  if (!result) {
    console.log(chalk.dim(L('\n  已取消, 没保存任何东西。\n', '\n  Cancelled — nothing saved.\n')));
    return 1;
  }

  const protocol = result.protocol as ProviderProtocol;
  const baseUrl = result.baseUrl?.trim() || PROVIDER_BASE_URLS[protocol];
  const store = new ProviderStore(loadConfig());
  store.addProvider({
    name: result.name.trim(),
    protocol,
    apiKey: result.apiKey.trim(),
    baseUrl,
    defaultModel: result.model,
    models: [result.model],
    setAsDefault: !store.getDefaultProvider(),
  });

  console.log('');
  console.log(chalk.green(L(`  ✓ Provider "${result.name.trim()}" 配置成功!`, `  ✓ Provider "${result.name.trim()}" added!`)));
  console.log(chalk.dim(`    Model: ${result.model}  ·  ${L('保存到', 'saved to')}: ${CONFIG_FILE}`));
  console.log('');
  console.log(chalk.dim(L('  开始使用: ', '  Start: ')) + chalk.bold('neox') + chalk.dim(L('  ·  验证 key: ', '  ·  check the key: ')) + chalk.bold('neox provider test'));
  console.log('');
  return 0;
}

/** 对 provider 的 models 端点做真实连通性测试 — 200 即 key 有效, 401/403 即无效. */
async function testProvider(id?: string): Promise<number> {
  const config = loadConfig();
  const store = new ProviderStore(config);
  const provider = id ? store.getProvider(id) : store.getDefaultProvider();

  if (!provider) {
    process.stderr.write(L(`Error: provider ${id ? `"${id}" 不存在` : '未配置'}。用 \`neox provider ls\` 查看。\n`,
      `Error: ${id ? `provider "${id}" not found` : 'no provider set up'}. See \`neox provider ls\`.\n`));
    return 1;
  }
  if (!provider.apiKey || !provider.apiKey.trim()) {
    process.stderr.write(L(`Error: provider "${provider.id}" 没有配置 API key。\n`, `Error: provider "${provider.id}" has no API key.\n`));
    return 1;
  }

  const isSentinel = provider.id === 'neox-cloud'
    || (provider.apiKey ?? '').trim() === 'neox-managed';
  if (isSentinel) {
    /* 这里不查登录态: 共享命令不许 import 商业目录 apps/cli/src/auth (check-edition-boundaries)。
     * 只测控制面通不通; 登录与否由用户自己确认 (提示里给 neox login)。 */
    const cloudBase = (process.env.NEOX_API_BASE || 'https://neox-dev.com').replace(/\/+$/, '');
    const healthUrl = `${cloudBase}/api/health`;
    console.log(chalk.dim(`  testing ${provider.id} → ${healthUrl}`));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(healthUrl, {
        signal: controller.signal,
        headers: { 'cache-control': 'no-cache' },
      });
      clearTimeout(timer);
      if (res.ok) {
        console.log(chalk.green(L(
          `  ✓ 订阅通道可达 (HTTP ${res.status})`,
          `  ✓ subscription reachable (HTTP ${res.status})`,
        )));
        console.log(chalk.dim(L('    还没登录的话: ', '    Not signed in yet? ')) + chalk.bold('neox login'));
        return 0;
      }
      console.log(chalk.red(L(
        `  ✗ 控制面返回 HTTP ${res.status}`,
        `  ✗ control plane returned HTTP ${res.status}`,
      )));
      return 1;
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? 'timeout (10s)' : (e?.message ?? String(e));
      console.log(chalk.red(`  ✗ ${L('网络失败', 'network error')}: ${msg}`));
      console.log(chalk.dim(L('    控制面地址: ', '    control plane: ')) + chalk.dim(cloudBase));
      return 1;
    }
  }

  const protocol = provider.protocol as string;
  const base = (provider.baseUrl || PROVIDER_BASE_URLS[protocol as ProviderProtocol] || '').replace(/\/+$/, '');
  if (!base) {
    process.stderr.write(L(`Error: provider "${provider.id}" 没有 baseUrl, 无法测试。\n`, `Error: provider "${provider.id}" has no baseUrl, can’t test it.\n`));
    return 1;
  }

  /* openai 兼容协议: GET /models; anthropic: GET /v1/models + x-api-key 头 */
  const isAnthropic = /anthropic/i.test(protocol);
  const url = isAnthropic
    ? `${base.replace(/\/v1$/, '')}/v1/models`
    : `${base}/models`;
  const headers: Record<string, string> = isAnthropic
    ? { 'x-api-key': provider.apiKey.trim(), 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${provider.apiKey.trim()}` };

  console.log(chalk.dim(`  testing ${provider.id} → ${url}`));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      console.log(chalk.green(L(`  ✓ key 有效 (HTTP ${res.status})`, `  ✓ key works (HTTP ${res.status})`)));
      return 0;
    }
    if (res.status === 401 || res.status === 403) {
      console.log(chalk.red(L(`  ✗ key 无效或无权限 (HTTP ${res.status})`, `  ✗ key invalid or not permitted (HTTP ${res.status})`)));
      console.log(chalk.dim(L('    重配: 进 REPL 跑 ', '    To fix: in the REPL run ')) + chalk.bold(`/provider edit ${provider.id}`));
      return 1;
    }
    console.log(chalk.yellow(L(`  ? 端点返回 HTTP ${res.status} — key 可能有效但 models 端点不可用`, `  ? endpoint returned HTTP ${res.status} — the key may work but the models endpoint isn’t available`)));
    return 0;
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'timeout (10s)' : (e?.message ?? String(e));
    console.log(chalk.red(`  ✗ ${L('网络失败', 'network error')}: ${msg}`));
    console.log(chalk.dim(L('    检查网络/代理设置, 或确认 baseUrl 是否正确: ', '    Check your network/proxy, or that the baseUrl is right: ')) + chalk.dim(base));
    return 1;
  }
}

export async function handleProviderCliCommand(args: string[]): Promise<number> {
  const sub = (args[0] ?? 'ls').toLowerCase();
  switch (sub) {
    case 'ls':
    case 'list':
      return listProviders();
    case 'add':
      return addProvider();
    case 'test':
      return testProvider(args[1]);
    case 'edit':
    case 'remove':
    case 'rm':
    case 'use':
    case 'default':
      console.log('');
      console.log(chalk.yellow(L(`  \`neox provider ${sub}\` 是交互式操作, 请在 REPL 内进行:`, `  \`neox provider ${sub}\` is interactive — do it in the REPL:`)));
      console.log(chalk.dim(L('    1. 跑 ', '    1. Run ')) + chalk.bold('neox') + chalk.dim(L(' 进入 REPL', ' to open the REPL')));
      console.log(chalk.dim(L('    2. 输入 ', '    2. Type ')) + chalk.bold(`/provider ${sub}${args[1] ? ` ${args[1]}` : ''}`));
      console.log('');
      return 1;
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return 0;
    default:
      process.stderr.write(L(`Error: 未知子命令 "provider ${sub}"\n`, `Error: unknown subcommand "provider ${sub}"\n`));
      printUsage();
      return 1;
  }
}
