const STALE_MODULE_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Outdated Optimize Dep/i,
];

export function isStaleModuleError(message: string | null | undefined): boolean {
  if (!message) return false;
  return STALE_MODULE_PATTERNS.some((re) => re.test(message));
}

/** 查看器「重试」按钮的统一行为: 模块地址失效 → 整页重载; 其它错误 → 照旧重跑加载。 */
export function retryOrReload(message: string | null | undefined, retry: () => void): void {
  if (isStaleModuleError(message)) {
    window.location.reload();
    return;
  }
  retry();
}

export function retryLabel(message: string | null | undefined, zh: boolean): string {
  if (isStaleModuleError(message)) return zh ? '重新加载界面' : 'Reload window';
  return zh ? '重试' : 'Retry';
}
