import chalk from 'chalk';
import { CONFIG_FILE, loadConfig } from '@neoxlabs/platform/utils/config.js';
import { ProviderStore } from '@neoxlabs/platform/utils/providerStore.js';
import { detectProvidersFromEnv, type DetectedProvider } from './providerDetection.js';

export function needsProviderConfiguration(): boolean {
  const config = loadConfig();
  const store = new ProviderStore(config);
  const defaultProvider = store.getDefaultProvider();
  return !(defaultProvider && defaultProvider.apiKey && defaultProvider.apiKey.trim().length > 0);
}

export function autoCreateProvidersFromEnv(): boolean {
  const detectedProviders = detectProvidersFromEnv();
  return autoCreateProvidersFromList(detectedProviders);
}

export function autoCreateProvidersFromList(detected: DetectedProvider[]): boolean {
  if (detected.length === 0) {
    return false;
  }
  const config = loadConfig();
  const store = new ProviderStore(config);
  for (const d of detected) {
    store.addProvider({
      name: d.name,
      protocol: d.protocol,
      apiKey: d.apiKey,
      baseUrl: d.baseUrl,
      models: d.models,
      defaultModel: d.models[0],
      setAsDefault: detected.length === 1,
    });
  }
  console.log();
  console.log(chalk.green(`✓ 已从环境变量创建 ${detected.length} 个 Provider！`));
  console.log(chalk.dim(`  配置已保存到: ${CONFIG_FILE}`));
  console.log();
  return true;
}
