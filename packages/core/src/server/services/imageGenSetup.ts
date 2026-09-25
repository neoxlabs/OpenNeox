/**
 * imageGenSetup — 把 NeoxCloud 网关凭证 + BYOK 配置注入 ImageGenService.
 *
 * 调用时机: server 启动时一次, config 变化时可幂等重跑.
 * 参考 ttsSetup.ensureTTSSummarizeFn 的模式.
 */

import { getImageGenService } from '../../services/imageGenService.js';
import type { ProviderConfigEntry } from '@neoxlabs/platform/utils/config.js';

type GetProvider = () => ProviderConfigEntry | undefined;
type GetProvidersList = () => Iterable<ProviderConfigEntry>;

export interface BYOKImageSettingBag {
  /** 是否启用 BYOK image (设置页开关). */
  enabled?: boolean;
  /** 上游 base URL, 如 'https://openrouter.ai/api/v1'. */
  baseUrl?: string;
  /** 上游 API key. */
  apiKey?: string;
  /** 展示名, 如 'OpenRouter'. */
  providerLabel?: string;
  /** OpenRouter 需要 X-Title + HTTP-Referer 之类. */
  extraHeaders?: Record<string, string>;
  /** 显式偏好 BYOK (即使云端也登录). 默认 false. */
  preferBYOK?: boolean;
}

type GetImageBYOK = () => BYOKImageSettingBag | undefined;

/**
 * 设置 cloud + BYOK resolver. 幂等.
 *   · getCloudProvider: 返 neoxcloud provider entry (有 baseUrl + apiKey) 或 undefined.
 *   · getImageBYOK:     返设置页里 BYOK 图像配置 或 undefined.
 */
export function setupImageGenResolvers(
  getCloudProvider: GetProvider,
  getImageBYOK: GetImageBYOK,
  getProvidersList?: GetProvidersList,
  getCloudImageModels?: () => string[],
): void {
  const svc = getImageGenService();
  svc.setCloudResolver(() => {
    const p = getCloudProvider();
    return p ? { baseUrl: p.baseUrl, apiKey: p.apiKey } : undefined;
  });
  svc.setBYOKResolver(() => {
    const bag = getImageBYOK();
    if (!bag?.enabled || !bag.baseUrl || !bag.apiKey) return undefined;
    return {
      baseUrl: bag.baseUrl,
      apiKey: bag.apiKey,
      extraHeaders: bag.extraHeaders,
      providerLabel: bag.providerLabel,
    };
  });
  /* 新架构: 全 providers 列表 → capability system 自动挑一个有 image 能力的.
   * 优先于 legacy BYOK. 用户在设置里把 OpenRouter provider 挂上 image capability, 就走这条. */
  if (getProvidersList) {
    svc.setProvidersResolver(getProvidersList);
  }
  if (getCloudImageModels) {
    svc.setCloudImageModelsResolver(getCloudImageModels);
  }
  /* preferBYOK 在每次 generate 前不好动态查, 简单起见开机读一次;
   * 用户在设置里切了要重启 server 生效 (跟 TTS 类似). */
  const bag = getImageBYOK();
  if (bag?.preferBYOK) {
    svc.setPreferBYOK(true);
  }
}
