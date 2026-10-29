/**
 * 市场地址的唯一出口
 *
 *   在这之前, 三处各自写了一遍 `process.env.NEOX_MARKETPLACE_URL || 'http://localhost:3721/api/v1'`
 *   —— 也就是说**发布出去的客户端默认打 localhost**, 用户永远看到一个空目录,
 *   而且看不出是为什么 (接口"没报错", 只是返回不了东西)。
 *
 *   同仓的 petRendererPlugins 早就写对了 (走 cloudEndpoints), 注释还写着「跟插件
 *   市场同一个 env」—— 但插件市场那边根本没用那套。这个文件就是把它收口。
 *
 *   为什么默认是 prod 而不是 localhost
 *   ---------------------------------
 *   默认值服务的是**用户**, 不是开发者。开发者要打本地, 设一个环境变量的成本几乎为零;
 *   用户拿到一个默认连 localhost 的客户端, 是没有任何办法自己发现问题的。
 *
 *   桌面端 (Electron) 另有一层: 它能通过 app.isPackaged 区分 dev/prod, 所以主进程
 *   启动时用 setMarketplaceBase() 把 cloudEndpoints 的结论灌进来, 覆盖这里的默认。
 */

const PROD_MARKETPLACE = 'https://neox-dev.com/api/v1';

let injectedBase: string | null = null;

/**
 * 宿主注入 (Electron 主进程启动时调用)。
 *
 *   传 null 表示撤回注入, 回到环境变量 / 默认值。
 */
export function setMarketplaceBase(base: string | null): void {
  injectedBase = base ? base.replace(/\/+$/, '') : null;
}

export function resolveMarketplaceBase(): string {
  if (process.env.NEOX_MARKETPLACE_URL) {
    return process.env.NEOX_MARKETPLACE_URL.replace(/\/+$/, '');
  }
  /* 跟桌面端 cloudEndpoints 同一个开关, 让 `NEOX_API_BASE=http://localhost:3721`
   * 这类既有用法在 CLI 下也生效 */
  if (process.env.NEOX_API_BASE) {
    return `${process.env.NEOX_API_BASE.replace(/\/+$/, '')}/api/v1`;
  }
  if (injectedBase) return injectedBase;
  return PROD_MARKETPLACE;
}
