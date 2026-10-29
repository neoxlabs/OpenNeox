
import { setupImageGenResolvers } from '@neoxlabs/core/server/services/imageGenSetup.js';
import { ProviderResolver } from '@neoxlabs/core/server/services/providerResolver.js';
import { readAvailableCloudImageModels } from '@neoxlabs/core/platform/membershipCacheRead.js';
import { resolveProviderEntry } from '@neoxlabs/platform/platform/providerResolver.js';
import { isNeoxManagedApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';

let wired = false;

/** 幂等. 主进程启动时调一次即可。 */
export function wireImageGenForDesktop(): void {
  if (wired) return;
  wired = true;

  const config = loadConfig();
  const providerResolver = new ProviderResolver(config as never);

  setupImageGenResolvers(
    /* ① 云端订阅 provider —— 跟 server 那份同款判定:
     *   认 id 'neox-cloud'(去连字符后 neoxcloud), 也认 apiKey 上的订阅 sentinel;
     *   拿到后必须过 resolveProviderEntry 换成真网关地址 + 真凭据 (裸 sentinel 发上游是 401)。 */
    () => {
      for (const p of providerResolver.getAllProviders()) {
        const id = String(p.id ?? '').replace(/-/g, '');
        if (id !== 'neoxcloud' && !isNeoxManagedApiKey(p.apiKey)) continue;
        return resolveProviderEntry(p);
      }
      return undefined;
    },
    /* ② 设置页里的 legacy BYOK 图像配置 */
    () => (config as { imageGen?: unknown } | undefined)?.imageGen as never,
    /* ③ 全部 provider (实时 + 解密) —— capability system 据此挑有 image 能力的那家。
     *    绝不能用 loadConfig().providers: 那是启动快照且 apiKey 是 enc:v1 密文。 */
    () => providerResolver.getAllProviders(),
    /* ④ 订阅侧可用出图模型 (读登录时已落盘的 membership 缓存) */
    () => readAvailableCloudImageModels(),
  );
}
