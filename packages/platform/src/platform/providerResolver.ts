import * as fsSyncModule from 'node:fs';
import * as osModule from 'node:os';
import * as pathModule from 'node:path';
import type { ProviderConfigEntry } from '../utils/config.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getRoutingState } from './routingState.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

function authEncCandidatesSync(): string[] {
  const home = osModule.homedir();
  const cliPath = pathModule.join(home, NEOX_HOME_DIRNAME, 'auth.enc');
  let desktopPath: string;
  if (process.platform === 'darwin') {
    desktopPath = pathModule.join(home, 'Library', 'Application Support', 'Neox', 'auth.enc');
  } else if (process.platform === 'win32') {
    desktopPath = pathModule.join(process.env.APPDATA || pathModule.join(home, 'AppData', 'Roaming'), 'Neox', 'auth.enc');
  } else {
    desktopPath = pathModule.join(process.env.XDG_CONFIG_HOME || pathModule.join(home, '.config'), 'neox', 'auth.enc');
  }
  return [cliPath, desktopPath];
}

function readAuthEncMtimeMsSync(): number {
  let maxMtime = 0;
  for (const p of authEncCandidatesSync()) {
    try {
      const m = fsSyncModule.statSync(p).mtimeMs;
      if (m > maxMtime) maxMtime = m;
    } catch { /* 这处不在, 看下一处 */ }
  }
  return maxMtime;
}

/** auth.enc 是否存在 (CLI ~/.neox 或 桌面路径任一) = 是否已登录. 统一供 stale 检测 + currentUserId 判定用. */
function authEncExistsSync(): boolean {
  return authEncCandidatesSync().some((p) => {
    try { return fsSyncModule.existsSync(p); } catch { return false; }
  });
}

/* 解析上下文 — 以后可以扩展 (调用场景: 'inline-complete' / 'agent' / 'tts' 等), 当前一档. */
export type ProviderResolveContext = {
  /** 触发改写的语义场景, resolver 可以按场景返回不同结果 */
  intent?: 'agent' | 'inline-complete' | 'tts' | 'embedding' | 'unknown';
};

export type ProviderResolver = (
  provider: ProviderConfigEntry,
  ctx?: ProviderResolveContext,
) => ProviderConfigEntry;

/* 路由不可用时 resolver 抛这种错 — 让 UI 立刻看到清晰错误, 不被吞成空 baseUrl.
 * 类型挂在 .name = 'NeoxRoutingError' 让 chatRecovery 等下游能识别 (不重连不重试). */
export class NeoxRoutingError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'NeoxRoutingError';
    this.code = code;
  }
}

let activeResolver: ProviderResolver | null = null;

/** host 启动时调一次, 注册改写函数. 传 null 复位为 identity. */
export function setProviderResolver(resolver: ProviderResolver | null): void {
  activeResolver = resolver;
}

export interface GatewayCredential {
  /** 完整 Bearer: 'nxk_<prefix>_<body>' (登录用户) 或 'anonkey_...' (匿名试用) */
  key: string;
  type: 'nxk' | 'anonkey';
  /** 凭据归属用户 id; 匿名为 null */
  userId: string | null;
}
/** 返回 null = host 没装 / 当前解不出凭据 → resolver 回落 routing.json (过渡期)。 */
export type CredentialProvider = () => GatewayCredential | null;

let credentialProvider: CredentialProvider | null = null;
/** host 启动时按 --identity-dir 装一次: 让 resolver 按本端身份现取网关凭据。传 null 复位。 */
export function setCredentialProvider(fn: CredentialProvider | null): void {
  credentialProvider = fn;
}

/** core 内部消费点 — 拿到原 provider 之后, runtime / config 调这个再返出去. */
export function resolveProviderEntry<T extends ProviderConfigEntry | null | undefined>(
  provider: T,
  ctx?: ProviderResolveContext,
): T {
  if (!provider) return provider;

  /* 字面量内联避免 const TDZ — NEOX_CLOUD_PROVIDER_ID / NEOX_MANAGED_APIKEY_MARKER 在文件下面声明. */
  const looksLikeSentinel = (provider as any).id === 'neox-cloud'
    || ((provider as any).apiKey ?? '').trim() === 'neox-managed';
  if (looksLikeSentinel && !activeResolver) {
    cliLogger.warn('PROVIDER_RESOLVER', 'sentinel hit but no activeResolver — using dbBased fallback');
    return dbBasedResolver(provider as ProviderConfigEntry) as T;
  }

  if (!activeResolver) return provider;
  return activeResolver(provider as ProviderConfigEntry, ctx) as T;
}

/* sentinel 常量 — 跟 desktop 端 src/ui/shared/neoxCloud.ts 对齐. */
const NEOX_CLOUD_PROVIDER_ID = 'neox-cloud';
const NEOX_MANAGED_APIKEY_MARKER = 'neox-managed';

let lastUserIdApplied: string | null = null;

/* ============================================================
 * 旧 file-based resolver 已删 — 真源切到 SQLite app_state (routingState.ts).
 * 兼容签名 installFileBasedRoutingResolver 还在, 内部 forward 到 db 版本.
 * 下面的 fileBasedResolver 是死函数 (无人调用), 留空壳保留类型签名以防外部 .d.ts 引用. */
function fileBasedResolver(provider: ProviderConfigEntry): ProviderConfigEntry {
  return dbBasedResolver(provider);
}

/* 旧 fileBasedResolver 实现已彻底删除 — 100+ 行 file-watching / stale / 匿名守门 逻辑全废,
 * 真源切到 SQLite 后这些防御都不需要了 (CredentialProvider 单一真源, 类型强约束). */

function dbBasedResolver(provider: ProviderConfigEntry): ProviderConfigEntry {
  const isNeoxManaged = provider.id === NEOX_CLOUD_PROVIDER_ID
    || (provider.apiKey ?? '').trim() === NEOX_MANAGED_APIKEY_MARKER;
  /* BYOK 路径无视 routing — 用户自己的 key 跟 baseUrl */
  if (!isNeoxManaged) return provider;

  /* 读 DB state */
  const state = getRoutingState();
  if (!state || state.enabled === false) {
    throw new NeoxRoutingError(
      'Neox Cloud 模型需要登录后使用；如果要走 BYOK, 请切换到本地 Provider 并配置自己的 API Key。',
      'NEOX_ROUTING_DISABLED',
    );
  }

  /* 取本端凭据 (架构重构 阶段1/2): identity-dir 下 gateway-key.enc 现取, 不依赖共享文件 */
  let credKey: string | undefined;
  let credUserId: string | null | undefined;
  if (credentialProvider) {
    try {
      const cred = credentialProvider();
      if (cred?.key) {
        credKey = cred.key;
        credUserId = cred.userId;
      }
    } catch (err) {
      cliLogger.warn('PROVIDER_RESOLVER', `credentialProvider 取凭据失败: ${(err as Error)?.message ?? err}`);
    }
  }
  if (!credKey) {
    throw new NeoxRoutingError(
      'Neox Cloud 网关凭据缺失。请重新登录以使用云端模型；如果要走 BYOK, 请切换到本地 Provider。',
      'NEOX_NO_CREDENTIAL',
    );
  }

  /* 同步 currentUserId 给 config.ts, 仅在变化时调。config 已全局化, 这里用于缓存失效/私有资源。 */
  if (credUserId !== lastUserIdApplied) {
    lastUserIdApplied = credUserId ?? null;
    void import('../utils/config.js').then((cfg) => {
      try { cfg.setCurrentUserId(credUserId ?? null); } catch { /* ignore */ }
    });
  }

  return { ...provider, apiKey: credKey, baseUrl: state.gatewayBase };
}

/** 安装 DB-based resolver. 传入 legacyPath = 老 routing.json 位置, 启动时迁移 + 删除. */
export async function installDbBasedRoutingResolver(legacyPath?: string): Promise<void> {
  if (legacyPath) {
    try {
      const { migrateFromLegacyRoutingFile } = await import('./routingState.js');
      const migrated = migrateFromLegacyRoutingFile(legacyPath);
      const fs = await import('node:fs');
      /* 不管 migrate 是否成功都删除 — 老文件不再使用 */
      try { fs.unlinkSync(legacyPath); cliLogger.info('PROVIDER_RESOLVER', `removed legacy routing.json (migrated=${migrated})`); } catch { /* file not there - fine */ }
      try { fs.unlinkSync(legacyPath + '.bak'); } catch { /* ignore */ }
    } catch (err) {
      cliLogger.warn('PROVIDER_RESOLVER', `legacy routing.json cleanup failed: ${(err as Error)?.message ?? err}`);
    }
  }
  setProviderResolver(dbBasedResolver);
  cliLogger.info('PROVIDER_RESOLVER', 'installed DB-based routing resolver');
}

export async function installFileBasedRoutingResolver(filePath: string): Promise<void> {
  await installDbBasedRoutingResolver(filePath);
}

/** 调用方拆装时复位 — 跟 setProviderResolver(null) 配合 */
export function uninstallFileBasedRoutingResolver(): void {
  setProviderResolver(null);
}
