export function isLiteEdition(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__NEOX_LITE__;
}
