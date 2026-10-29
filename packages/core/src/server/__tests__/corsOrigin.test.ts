/** CORS 只放行 localhost 与 127.0.0.1 的可选端口。 */
import { describe, it, expect } from 'vitest';

/* 与 index.ts 里同一份判定 —— 这里单独钉行为, 免得改动时又退回精确比对。 */
const isLocalOrigin = (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

describe('CORS origin 判定', () => {
  it('本机任意端口放行 —— dev server 端口是动态的', () => {
    for (const o of ['http://127.0.0.1:5180', 'http://localhost:3000', 'https://127.0.0.1:8443', 'http://localhost']) {
      expect(isLocalOrigin(o), o).toBe(true);
    }
  });

  it('非本机一律不放行 —— 包括长得像本机的域名', () => {
    /* 127.0.0.1.evil.com / localhost.attacker.net 这类是真实绕过手法,
     * 正则必须锚到结尾, 不能用 startsWith。 */
    for (const o of ['http://evil.com', 'http://127.0.0.1.evil.com', 'http://localhost.attacker.net', 'http://notlocalhost']) {
      expect(isLocalOrigin(o), o).toBe(false);
    }
  });
});
