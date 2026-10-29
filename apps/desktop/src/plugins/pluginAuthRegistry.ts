/**
 * Plugin Auth Registry — 已启用 auth 插件贡献的订阅 OAuth Provider
 *
 * 宿主不打包 @neoxlabs/oauth-*；插件自带实现，本表只登记实例与元数据。
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/** 与 @neoxlabs/oauth AuthProvider 结构对齐的最小契约（避免宿主硬依赖 oauth 包） */
export interface AuthProviderLike {
  readonly id: string;
  readonly displayName: string;
  readonly authKind: string;
  login(opts?: Record<string, unknown>): Promise<AuthTokenBundle>;
  refresh(tokens: AuthTokenBundle): Promise<AuthTokenBundle>;
  logout(): Promise<void>;
  status(): Promise<AuthStatusLike>;
  toProviderCredential?(tokens: AuthTokenBundle): AuthCredentialHint;
}

export interface AuthTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  extra?: Record<string, unknown>;
}

export interface AuthStatusLike {
  state: 'logged_out' | 'logged_in' | 'expired' | 'refreshing' | string;
  providerId: string;
  expiresAt?: number;
  accountHint?: string;
}

export interface AuthCredentialHint {
  providerId: string;
  baseUrl: string;
  authHeader: 'Bearer' | 'x-api-key' | 'anthropic-oauth' | string;
  defaultModel?: string;
  protocolHint?: string;
}

export interface RegisteredAuthProvider {
  pluginName: string;
  providerId: string;
  displayName: string;
  authKind: string;
  installDir: string;
  entry: string;
  exportName: string;
  instance: AuthProviderLike;
}

export class PluginAuthRegistry {
  private readonly byPlugin = new Map<string, RegisteredAuthProvider>();
  private readonly byProviderId = new Map<string, RegisteredAuthProvider>();

  register(entry: RegisteredAuthProvider): void {
    this.unregisterPlugin(entry.pluginName, false);
    const existing = this.byProviderId.get(entry.providerId);
    if (existing && existing.pluginName !== entry.pluginName) {
      cliLogger.warn(
        'PLUGIN_AUTH',
        `provider id "${entry.providerId}" already from [${existing.pluginName}], replacing with [${entry.pluginName}]`,
      );
      this.byPlugin.delete(existing.pluginName);
    }
    this.byPlugin.set(entry.pluginName, entry);
    this.byProviderId.set(entry.providerId, entry);
    cliLogger.info('PLUGIN_AUTH', `[${entry.pluginName}] registered auth provider "${entry.providerId}"`);
  }

  unregisterPlugin(pluginName: string, log = true): number {
    const entry = this.byPlugin.get(pluginName);
    if (!entry) return 0;
    this.byPlugin.delete(pluginName);
    if (this.byProviderId.get(entry.providerId)?.pluginName === pluginName) {
      this.byProviderId.delete(entry.providerId);
    }
    if (log) cliLogger.info('PLUGIN_AUTH', `[${pluginName}] unregistered auth provider`);
    return 1;
  }

  getByPlugin(pluginName: string): RegisteredAuthProvider | undefined {
    return this.byPlugin.get(pluginName);
  }

  getByProviderId(providerId: string): RegisteredAuthProvider | undefined {
    return this.byProviderId.get(providerId);
  }

  list(): RegisteredAuthProvider[] {
    return [...this.byPlugin.values()];
  }

  clear(): void {
    this.byPlugin.clear();
    this.byProviderId.clear();
  }
}

export const pluginAuthRegistry = new PluginAuthRegistry();

/** BYOK provider id 约定: oauth-<providerId> */
export function linkedProviderIdFor(authProviderId: string): string {
  return `oauth-${authProviderId}`;
}
