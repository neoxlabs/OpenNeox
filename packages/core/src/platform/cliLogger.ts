/**
 * Compatibility re-export — platform modules live in @neoxlabs/platform.
 * Kept so existing `@neoxlabs/core/platform/cliLogger.js` import paths still resolve
 * (ink vendor, desktop, cli still import via the core path).
 */
export * from '@neoxlabs/kernel/platform/cliLogger.js';
