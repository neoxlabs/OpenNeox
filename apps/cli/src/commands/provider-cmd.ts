import chalk from 'chalk';
import { loadConfig, CONFIG_FILE, type NeoxConfig, type ProviderProtocol } from '@neoxlabs/platform/utils/config.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import { PROVIDER_BASE_URLS } from '../constants.js';

function printUsage(): void {
  console.log(`
Usage: neox provider <command>

Commands:
  ls, list           列出已配置的 provider (List configured providers)
  add                交互式添加 BYOK provider (Add a provider interactively)
  test [id]          测试 provider key 连通性 (Test provider key against its API)
  edit / remove /    交互式管理请在 REPL 内进行 (Manage interactively in the REPL):
  use / default        neox → /provider edit <id> 等

Examples:
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
    console.log(chalk.yellow('  尚未配置任何 provider'));
    console.log('');
    console.log(chalk.cyan('  两种方式开始:'));
    console.log(chalk.dim('    ') + chalk.bold('neox login') + chalk.dim('          # NeoxCloud 订阅, 多模型零配置'));
    console.log(chalk.dim('    ') + chalk.bold('neox provider add') + chalk.dim('   # BYOK 用自己的 API key'));
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
    process.stderr.write('Error: `neox provider add` 是交互式向导, 需要 TTY。\n');
    process.stderr.write('  管道/CI 环境请改用环境变量 (如 export OPENAI_API_KEY=sk-...) 或 `neox login`。\n');
    return 1;
  }

  /* 复用首启引导同一套 Ink 向导 + save 逻辑 (ensureProviderConfigured 的 manual 路径) */
  const { runInkInteractiveSetup } = await import('../provider/providerSetupUI.js');
  const result = await runInkInteractiveSetup();
  if (!result) {
    console.log(chalk.dim('\n  已取消, 没保存任何东西。\n'));
    return 1;
  }

  const protocol = result.protocol as ProviderProtocol;
  const baseUrl = result.baseUrl?.trim() || PROVIDER_BASE_URLS[protocol];
  const newConfig: NeoxConfig = { providers: {} };
  const newStore = new ProviderStore(newConfig);
  newStore.addProvider({
    name: result.name.trim(),
    protocol,
    apiKey: result.apiKey.trim(),
    baseUrl,
    defaultModel: result.model,
    models: [result.model],
    setAsDefault: true,
  });

  console.log('');
  console.log(chalk.green(`  ✓ Provider "${result.name.trim()}" 配置成功!`));
  console.log(chalk.dim(`    Model: ${result.model}  ·  保存到: ${CONFIG_FILE}`));
  console.log('');
  console.log(chalk.dim('  开始使用: ') + chalk.bold('neox') + chalk.dim('  ·  验证 key: ') + chalk.bold('neox provider test'));
  console.log('');
  return 0;
}

/** 对 provider 的 models 端点做真实连通性测试 — 200 即 key 有效, 401/403 即无效. */
async function testProvider(id?: string): Promise<number> {
  const config = loadConfig();
  const store = new ProviderStore(config);
  const provider = id ? store.getProvider(id) : store.getDefaultProvider();

  if (!provider) {
    process.stderr.write(`Error: provider ${id ? `"${id}" 不存在` : '未配置'}。用 \`neox provider ls\` 查看。\n`);
    return 1;
  }
  if (!provider.apiKey || !provider.apiKey.trim()) {
    process.stderr.write(`Error: provider "${provider.id}" 没有配置 API key。\n`);
    return 1;
  }

  const protocol = provider.protocol as string;
  const base = (provider.baseUrl || PROVIDER_BASE_URLS[protocol as ProviderProtocol] || '').replace(/\/+$/, '');
  if (!base) {
    process.stderr.write(`Error: provider "${provider.id}" 没有 baseUrl, 无法测试。\n`);
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
      console.log(chalk.green(`  ✓ key 有效 (HTTP ${res.status})`));
      return 0;
    }
    if (res.status === 401 || res.status === 403) {
      console.log(chalk.red(`  ✗ key 无效或无权限 (HTTP ${res.status})`));
      console.log(chalk.dim('    重配: 进 REPL 跑 ') + chalk.bold(`/provider edit ${provider.id}`));
      return 1;
    }
    console.log(chalk.yellow(`  ? 端点返回 HTTP ${res.status} — key 可能有效但 models 端点不可用`));
    return 0;
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'timeout (10s)' : (e?.message ?? String(e));
    console.log(chalk.red(`  ✗ 网络失败: ${msg}`));
    console.log(chalk.dim('    检查网络/代理设置, 或确认 baseUrl 是否正确: ') + chalk.dim(base));
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
      console.log(chalk.yellow(`  \`neox provider ${sub}\` 是交互式操作, 请在 REPL 内进行:`));
      console.log(chalk.dim('    1. 跑 ') + chalk.bold('neox') + chalk.dim(' 进入 REPL'));
      console.log(chalk.dim('    2. 输入 ') + chalk.bold(`/provider ${sub}${args[1] ? ` ${args[1]}` : ''}`));
      console.log('');
      return 1;
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      return 0;
    default:
      process.stderr.write(`Error: 未知子命令 "provider ${sub}"\n`);
      printUsage();
      return 1;
  }
}
