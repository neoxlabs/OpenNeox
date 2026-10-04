/**
 * commands/models-cmd — neox model[s] <subcommand>
 *
 *   子命令:
 *     neox model ls [--json] [--source=cloud|byok|all]
 *         合并显示 NeoxCloud 订阅 model + BYOK provider model.
 *
 *   注: 老 `commands/model.ts` 是 REPL slash command (`/model`) 用, 跟这里互不相干.
 *   这里是 cli root level subcommand (`neox model ls`).
 *
 *   NeoxCloud 段由账号插槽提供 (商业版 auth/cloudModels.ts); 公开版只有 BYOK 段。
 */

import chalk from 'chalk';
import { getCliEdition } from '../edition/index.js';

interface ModelEntry {
  id: string;
  source: 'NeoxCloud' | 'BYOK';
  providerName: string;
  plan?: string | null;
  protocol?: string;
  capability?: string;
}

export async function handleModelCliCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return sub ? 0 : 1;
  }
  if (sub === 'ls' || sub === 'list') {
    return await listModels(args.slice(1));
  }
  console.error(`未知子命令: ${sub}`);
  printHelp();
  return 1;
}

async function listModels(args: string[]): Promise<number> {
  const wantJson = args.includes('--json');
  let sourceFilter: 'cloud' | 'byok' | 'all' = 'all';
  for (const a of args) {
    if (a === '--source=cloud') sourceFilter = 'cloud';
    else if (a === '--source=byok') sourceFilter = 'byok';
    else if (a === '--source=all') sourceFilter = 'all';
  }

  const models: ModelEntry[] = [];
  const errors: string[] = [];

  /* 1. NeoxCloud 订阅 model (账号插槽; 公开版没有这一段) */
  const account = getCliEdition().account;
  if (account && (sourceFilter === 'all' || sourceFilter === 'cloud')) {
    const cloud = await account.listCloudModels({ cloudOnly: sourceFilter === 'cloud' });
    for (const m of cloud.models) models.push({ ...m, source: 'NeoxCloud' });
    errors.push(...cloud.errors);
  }

  /* 2. BYOK provider model */
  if (sourceFilter === 'all' || sourceFilter === 'byok') {
    try {
      const { loadConfig } = await import('@neoxlabs/platform/utils/config.js' as any);
      const { ProviderStore } = await import('@neoxlabs/platform/utils/providerStore.js' as any);
      const config = loadConfig();
      const store = new ProviderStore(config);
      /* providerStore 有些版本 listProviders 不存在, fallback 用 config.providers 字典 */
      let allProviders: any[];
      if (typeof (store as any).listProviders === 'function') {
        allProviders = (store as any).listProviders();
      } else {
        allProviders = Object.values((config as any).providers || {});
      }
      for (const p of allProviders) {
        if (p.id === 'neox-cloud') continue; /* sentinel 不算 BYOK */
        const providerModels = p.models || [];
        for (const m of providerModels) {
          const id = typeof m === 'string' ? m : m.name;
          if (!id) continue;
          models.push({
            id,
            source: 'BYOK',
            providerName: p.name || p.id,
            protocol: p.protocol,
          });
        }
      }
    } catch (e: any) {
      errors.push(`本地 BYOK 加载失败: ${e?.message?.slice(0, 80) || '未知'}`);
    }
  }

  if (wantJson) {
    console.log(JSON.stringify({ models, errors }, null, 2));
    return 0;
  }

  console.log('');
  console.log(`  ${chalk.bold('Models')}  (${models.length} 个)`);
  if (errors.length > 0) {
    console.log('');
    for (const err of errors) console.log(`  ${chalk.yellow('⚠')} ${err}`);
  }
  if (models.length === 0) {
    console.log('');
    console.log(`  ${chalk.gray('•')} 没找到 model.`);
    if (!account) {
      console.log(`  ${chalk.gray('  ')} 跑 ${chalk.bold('neox provider add')} 配置 BYOK.`);
    } else if (!account.isLoggedIn()) {
      console.log(`  ${chalk.gray('  ')} 跑 ${chalk.bold('neox login')} 用订阅, 或 ${chalk.bold('neox provider add')} 用 BYOK.`);
    }
    console.log('');
    return 0;
  }

  console.log('');
  console.log(`    ${chalk.gray('ID'.padEnd(28))} ${chalk.gray('Source'.padEnd(12))} ${chalk.gray('Provider'.padEnd(20))} ${chalk.gray('Notes')}`);
  console.log(`    ${chalk.gray('─'.repeat(80))}`);
  for (const m of models) {
    const id = m.id.padEnd(28).slice(0, 28);
    const sourceTag = m.source === 'NeoxCloud'
      ? chalk.cyan('NeoxCloud'.padEnd(12))
      : chalk.green('BYOK'.padEnd(12));
    const provider = (m.providerName || '').padEnd(20).slice(0, 20);
    const notes: string[] = [];
    if (m.plan) notes.push(`plan=${m.plan}`);
    if (m.protocol) notes.push(`proto=${m.protocol}`);
    if (m.capability) notes.push(m.capability);
    console.log(`    ${id} ${sourceTag} ${provider} ${chalk.gray(notes.join(' · '))}`);
  }
  console.log('');
  console.log(`  ${chalk.gray('用某 model:')}  ${chalk.bold('neox -p "..." --model <id>')}  (也可 --provider <id> 强制)`);
  console.log('');
  return 0;
}

function printHelp(): void {
  if (!getCliEdition().account) {
    console.log(`
${chalk.bold('neox model')} — 模型列表 (BYOK)

${chalk.bold('用法:')}
  neox model ls [--json]

${chalk.bold('字段:')}
  ID         model id (gpt-5.4 / claude-sonnet-4-6 / glm-5)
  Source     BYOK (自管 API key)
  Provider   所属 provider
  Notes      protocol
`);
    return;
  }
  console.log(`
${chalk.bold('neox model')} — 模型列表 (合并 NeoxCloud 订阅 + BYOK)

${chalk.bold('用法:')}
  neox model ls [--json] [--source=cloud|byok|all]

${chalk.bold('字段:')}
  ID         model id (gpt-5.4 / claude-sonnet-4-6 / glm-5)
  Source     NeoxCloud (订阅 quota) / BYOK (自管 API key)
  Provider   所属 provider
  Notes      plan / protocol / capability tier

${chalk.bold('实例:')}
  neox model ls --source=cloud      # 只订阅 model
  neox model ls --source=byok       # 只 BYOK
  neox model ls --json              # 给脚本
`);
}
