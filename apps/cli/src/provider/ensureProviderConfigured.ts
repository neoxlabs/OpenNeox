import chalk from 'chalk';
import { CONFIG_FILE, loadConfig, type NeoxConfig, type ProviderProtocol } from '@neoxlabs/platform/utils/config.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import { PROVIDER_BASE_URLS } from '../constants.js';
import { runInkInteractiveSetup, runInkWelcomeMenu } from './providerSetupUI.js';
import type { WelcomeMenuChoice } from '../ink/components/WelcomeMenu.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { loadWorkspaceConfig } from '../utils/workspaceConfig.js';
import { getCliEdition } from '../edition/index.js';

/* 圈号 —— 首启提示的编号, 公开版少一项 (没有 neox login), 按实际条数编 */
const CIRCLED = ['①', '②', '③', '④'];

export async function ensureProviderConfigured(): Promise<void> {
  const account = getCliEdition().account;
  const earlyUserId = account ? account.currentUserId() : null;
  if (earlyUserId) {
    try {
      const cfg = await import('@neoxlabs/platform/utils/config.js' as any);
      cfg.setCurrentUserId(earlyUserId);
    } catch { /* setCurrentUserId 失败影响小, 走 anonymous 兜底 */ }
  }

  const config = loadConfig();
  const store = new ProviderStore(config);

  const workspace = loadWorkspaceConfig();
  if (workspace?.defaultProvider) {
    const wsProvider = store.getProvider(workspace.defaultProvider);
    if (wsProvider) {
      /* sentinel neox-cloud 即使无 apiKey 也算 ready (runtime resolver 兜底) */
      if (wsProvider.id === 'neox-cloud' || (wsProvider.apiKey && wsProvider.apiKey.trim())) {
        return;
      }
    }
    /* workspace 指定了 provider 但 store 没找到 — 不报错, fall through 走常规 detect */
  }

  /* State A / A.5 / A.6 · 账号 / 订阅 / 桌面 SSO / 云端 key 兜底 —— 账号插槽 (公开版没有) */
  if (account && (await account.checkProviderReady(store)) === 'ready') {
    return;
  }

  /* State B · 有可用 BYOK default → OK */
  const defaultProvider = store.getDefaultProvider();
  if (defaultProvider && defaultProvider.apiKey && defaultProvider.apiKey.trim().length > 0
      && defaultProvider.id !== 'neox-cloud') { /* sentinel 不算 BYOK */
    return;
  }

  /* State C · 都没配 → 全新用户首次启动 */

  /* Non-TTY (pipe/-p) 路径 — 不能弹 Ink, 友好打印怎么修后退出. */
  if (!process.stdin.isTTY) {
    console.log('');
    console.log(chalk.yellow('  ✗ 尚未配置 AI Provider, 一次性命令 / 管道模式无法弹交互配置'));
    console.log('');
    console.log(chalk.cyan('  请先配置, 再重试本命令:'));
    const options = [
      ...(account ? [chalk.bold('neox login') + chalk.dim('              # 推荐 — NeoxCloud 订阅, 多模型零配置')] : []),
      chalk.bold('neox provider add') + chalk.dim('       # BYOK 用你自己的 API key'),
      chalk.bold('export OPENAI_API_KEY=sk-...') + chalk.dim('  # 环境变量方式 (启动时自动检测)'),
    ];
    options.forEach((line, i) => console.log(chalk.dim(`    ${CIRCLED[i]} `) + line));
    console.log('');
    process.exit(1);
  }

  let choice: WelcomeMenuChoice = 'exit';
  let byokResult: import('../ink/components/InteractiveProviderSetup.js').ProviderConfigResult | null = null;
  let byokAlreadySaved = false;
  while (true) {
    /* 公开版没有账号 → 菜单里不出 "登录 NeoxCloud" 那一项 */
    choice = await runInkWelcomeMenu({ showLogin: !!account });
    if (choice !== 'byok') break;
    const { detectProvidersFromEnv } = await import('./providerDetection.js');
    const detected = detectProvidersFromEnv();
    if (detected.length > 0) {
      const { runInkProviderSetupWizard } = await import('./providerSetupUI.js');
      const wizardResult = await runInkProviderSetupWizard();
      if (wizardResult.choice === 'auto') {
        /* user 勾选了某几个 detected → 取 subset 创建 */
        const { autoCreateProvidersFromList } = await import('./providerSetupState.js');
        const subset = wizardResult.selectedIndices.map((i: number) => wizardResult.detectedProviders[i]).filter(Boolean);
        if (subset.length === 0) {
          /* 全没选 → 当 user 没确定, 回 WelcomeMenu */
          continue;
        }
        try {
          const ok = autoCreateProvidersFromList(subset);
          if (ok) {
            /* autoCreateProvidersFromList 内部已经 ProviderStore.addProvider + persist.
             * 跳过 outer save block (它会重复 addProvider 用 byokResult, apiKey 空抛错). */
            byokAlreadySaved = true;
            break;
          }
        } catch (e) {
          cliLogger.warn('SETUP', `auto-create from env failed: ${(e as any)?.message ?? e}, falling to manual`);
        }
      } else if (wizardResult.choice === 'exit') {
        continue; // 回 WelcomeMenu
      }
      /* 'manual' / 'setup' → fall through to manual wizard */
    }
    byokResult = await runInkInteractiveSetup();
    if (byokResult) break; // 成功配 → 走后面保存逻辑
    /* ESC / 取消 → 回 menu 重选 (可能改主意用 login) */
  }

  if (choice === 'login' && account) {
    /* 登录 + spawn self 接管进程 (账号插槽, 见 auth/providerReady.ts runOnboardingLogin) */
    return account.runOnboardingLogin();
  }
  if (choice === 'exit' || choice === 'login') {
    console.log('');
    console.log(`  ${chalk.gray('•')} 已退出. 没保存任何东西.`);
    console.log('');
    console.log(`  ${chalk.cyan('下次想配, 跑任一条:')}`);
    if (account) {
      console.log(chalk.dim('    ') + chalk.bold('neox login') + chalk.dim('           # NeoxCloud 订阅 (推荐 — 多模型 + 跨设备同步)'));
    }
    console.log(chalk.dim('    ') + chalk.bold('neox provider add') + chalk.dim('    # BYOK 用自己的 API key'));
    console.log(chalk.dim('    ') + chalk.bold('neox') + chalk.dim('                 # 重新弹这个引导菜单'));
    console.log('');
    process.exit(0);
  }

  /* 落到这里 = outer loop break 出来. 两种情况:
   *   ① byokAlreadySaved = true → env auto-detect 已 save, 直接 return 不重复 addProvider
   *   ② byokResult non-null     → manual wizard 完成, 走下面 save block */
  if (byokAlreadySaved) {
    console.log();
    console.log(chalk.cyan('  快速开始:'));
    console.log(chalk.dim('    输入消息开始对话 · 或 ') + chalk.cyan('/help') + chalk.dim(' 看命令'));
    console.log(chalk.dim('    切模型: ') + chalk.cyan('/model') + chalk.dim(' · 加新 provider: ') + chalk.cyan('/provider add'));
    console.log();
    return;
  }
  const result = byokResult!;
  const protocol = result.protocol as ProviderProtocol;
  const baseUrl = result.baseUrl?.trim() || PROVIDER_BASE_URLS[protocol];
  const modelList = [result.model];

  const newConfig: NeoxConfig = { providers: {} };
  const newStore = new ProviderStore(newConfig);
  newStore.addProvider({
    name: result.name.trim(),
    protocol,
    apiKey: result.apiKey.trim(),
    baseUrl,
    defaultModel: result.model,
    models: modelList,
    setAsDefault: true,
  });

  console.log();
  console.log(chalk.green(`  ✓ Provider "${result.name.trim()}" 配置成功!`));
  console.log(chalk.dim(`    Model: ${result.model}  ·  保存到: ${CONFIG_FILE}`));
  console.log();
  console.log(chalk.cyan('  快速开始:'));
  console.log(chalk.dim('    输入消息开始对话 · 或 ') + chalk.cyan('/help') + chalk.dim(' 看命令'));
  console.log(chalk.dim('    切模型: ') + chalk.cyan('/model') + chalk.dim(' · 加新 provider: ') + chalk.cyan('/provider add'));
  if (account) {
    console.log(chalk.dim('    升级 NeoxCloud 订阅: ') + chalk.cyan('neox login') + chalk.dim(' (订阅模型 + 跨设备同步)'));
  }
  console.log();
}
