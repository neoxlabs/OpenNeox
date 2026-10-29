/**
 * Neox 托管 provider 共享常量 — renderer 和 electron main 共用.
 *
 *   背景: neoxCloudProviderSync (renderer) 创建 'neox-cloud' provider 时塞一个 sentinel
 *   apiKey 占位, neoxRoutingService (main) 看到这个 sentinel 就强制改写到网关. 之前两侧
 *   各自硬编 'neox-cloud' / 'neox-managed' 字符串, 一旦改一头另一头漏掉, sentinel 就
 *   失去意义, 出现"Pro+ 用户 auto 模型直连 api.openai.com"那一类隐 bug. 抽到这里集中放.
 */

/** 本地 config 里 Neox 托管 provider 的固定 id. providerStore 用它去重 + resolver 用它兜底识别. */
export const NEOX_CLOUD_PROVIDER_ID = 'neox-cloud';

/** Neox 托管 provider 的显示名 (admin / 设置面板里给用户看). */
export const NEOX_CLOUD_PROVIDER_NAME = 'Neox Cloud';

/**
 * 「按量」组模型用的 providerId —— **不是**本地 config 里的一个 provider, 只是一个路由记号:
 * 服务端 ProviderResolver 把它映射回 'neox-cloud' 那一套 (同一个网关、同一把凭据), 只多带
 * `X-Neox-Billing: payg` 头, 网关据此只扣平台钱包、按平台价, 不碰订阅额度。
 * 跟 packages/core ProviderResolver 里的同名常量必须一致。
 */
export const NEOX_CLOUD_PAYG_PROVIDER_ID = 'neox-cloud-payg';

/** 模型是不是走 Neox 网关的 (订阅 + 按量两组都算) —— 判"云端 vs BYOK"一律用它 */
export function isNeoxCloudProviderId(providerId: string | null | undefined): boolean {
  return providerId === NEOX_CLOUD_PROVIDER_ID || providerId === NEOX_CLOUD_PAYG_PROVIDER_ID;
}

/** 运行时事件 / 用量记录里的 provider 字段有时是 id、有时是显示名, 两个都要认。 */
export function isNeoxCloudProvider(provider: string | null | undefined): boolean {
  return isNeoxCloudProviderId(provider) || provider === NEOX_CLOUD_PROVIDER_NAME;
}

/**
 * 占位 apiKey sentinel. providerStore 校验 apiKey 必须非空, 但 Neox 托管 provider 真正的
 * key 是 main 进程在运行时改写进去的, sync 写入时这一格只能填一个 marker.
 *
 * resolver 看到这个值 (或 provider.id === NEOX_CLOUD_PROVIDER_ID) 就走网关, 不走 BYOK 透传.
 */
export const NEOX_MANAGED_APIKEY_MARKER = 'neox-managed';
