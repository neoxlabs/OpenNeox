import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { __ssrfTestSurface as S } from '../linkPreviewHandlers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../linkPreviewHandlers.ts'), 'utf8');


describe('内网判定认得出各种等价写法', () => {
  const priv = [
    '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1',
    '169.254.169.254',              /* 云元数据, SSRF 的头号目标 */
    'localhost', 'foo.local', 'svc.internal',
    '0177.0.0.1',                   /* 八进制 */
    '0x7f.0.0.1',                   /* 十六进制 */
    '2130706433',                   /* 单个十进制整数 */
    '127.1',                        /* 两段短形式 */
    '[::1]', '::1',
    '[::ffff:127.0.0.1]',           /* IPv4-mapped IPv6 */
    'fe80::1', 'fd00::1',
    '100.64.0.1',                   /* CGNAT */
  ];
  for (const h of priv) {
    it(`拦住 ${h}`, () => expect(S.isPrivateHost(h)).toBe(true));
  }

  /* 对照组 —— 拦过头会让所有链接卡片都不出预览 */
  const pub = ['example.com', 'github.com', '8.8.8.8', '1.1.1.1', '93.184.216.34', 'www.google.com'];
  for (const h of pub) {
    it(`放行 ${h}`, () => expect(S.isPrivateHost(h)).toBe(false));
  }
});

describe('跳转逐跳校验', () => {
  it('不再用 redirect: follow —— 那样看不到中间跳到哪儿', () => {
    /* 代码形态带尾逗号或右括号; 文件头注释里写的是 `redirect:'follow':` (冒号结尾), 撞不上 */
    expect(SRC).not.toMatch(/redirect:\s*'follow'\s*[,)]/);
    expect(SRC).toMatch(/redirect:\s*'manual'\s*[,)}]/);
  });

  it("'redirect' 事件里重新判 isPrivateHost, 通过才 followRedirect", () => {
    const i = SRC.indexOf("req.on('redirect'");
    expect(i, "找不到 redirect 事件处理").toBeGreaterThan(0);
    const block = SRC.slice(i, i + 1200);
    expect(block).toMatch(/isPrivateHost\(next\.hostname\)/);
    expect(block).toMatch(/followRedirect\(\)/);
  });

  it('跳转次数有上限', () => {
    expect(SRC).toMatch(/MAX_REDIRECTS/);
  });
});
