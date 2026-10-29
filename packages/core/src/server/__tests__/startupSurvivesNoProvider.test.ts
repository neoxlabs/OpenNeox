import { describe, it, expect, vi } from 'vitest';

describe('启动时拿不到默认 provider', () => {
  it('getDefaultProvider 抛错时要能兜住, 不能让启动流程整个挂掉', () => {
    /* 钉的是这个模式本身: 取默认 provider 必须包在 try 里, 失败降级成 undefined。 */
    const resolver = {
      getDefaultProvider: vi.fn(() => {
        throw new Error('Neox Cloud 网关凭据缺失。请重新登录以使用云端模型');
      }),
    };

    let defaultProvider: unknown;
    expect(() => {
      try {
        defaultProvider = resolver.getDefaultProvider();
      } catch {
        defaultProvider = undefined;
      }
    }).not.toThrow();
    expect(defaultProvider).toBeUndefined();
  });

  it('main.ts 里那处确实包了 try —— 防止以后被改回裸调用', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../main.ts'),
      'utf8',
    );
    /* 裸的 `const defaultProvider = providerResolver.getDefaultProvider();` 就是老写法。 */
    expect(src).not.toMatch(/const defaultProvider = providerResolver\.getDefaultProvider\(\);/);
    expect(src).toMatch(/defaultProvider = providerResolver\.getDefaultProvider\(\);/);
  });
});
