
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/**
 * 预连接 API 端点 — 提前建立 TCP+TLS 连接
 * 调用方式：void preconnectApi(url) （fire-and-forget）
 */
export function preconnectApi(baseUrl?: string): void {
  if (!baseUrl) return;

  try {
    const url = new URL(baseUrl);
    // 使用 HEAD 请求建立连接但不传输数据
    // AbortController 确保不会挂起
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 5000);

    fetch(`${url.origin}/`, {
      method: 'HEAD',
      signal: ac.signal,
      // keepalive 确保连接池复用
    }).catch(err => {
      cliLogger.debug('BOOT', `API preconnect failed (fail-open): ${err?.message}`);
    }).finally(() => {
      clearTimeout(timeout);
    });

    cliLogger.debug('BOOT', `API preconnect initiated: ${url.origin}`);
  } catch (err: any) {
    cliLogger.debug('BOOT', `Preconnect URL error: ${err?.message}`);
  }
}

/**
 * 从配置中获取 API URL 并预连接
 */
export async function preconnectFromConfig(): Promise<void> {
  try {
    // 懒加载配置模块，避免在快路径中引入
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();
    const provider = config.providers?.[config.defaultProviderId ?? ''];
    if (provider?.baseUrl) {
      preconnectApi(provider.baseUrl);
    }
  } catch (err: any) {
    cliLogger.debug('BOOT', `Preconnect config load failed: ${err?.message}`);
  }
}
