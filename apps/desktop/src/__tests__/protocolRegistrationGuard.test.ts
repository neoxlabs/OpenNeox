import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

const ROOT = path.resolve(__dirname, '../../../..');
const BUILDER = JSON.parse(readFileSync(path.join(ROOT, 'electron-builder.json'), 'utf8'));
const MAIN = readFileSync(path.resolve(__dirname, '../ui/electron/main.ts'), 'utf8');
const OAUTH = readFileSync(path.resolve(__dirname, '../ui/electron/services/oauthFlow.ts'), 'utf8');

/** 打包配置里声明给操作系统的 scheme */
function declaredSchemes(): Set<string> {
  const out = new Set<string>();
  for (const proto of BUILDER.protocols ?? []) {
    for (const scheme of proto.schemes ?? []) out.add(String(scheme));
  }
  return out;
}

/** 代码里认领的 scheme: 运行时注册的 + OAuth 回调地址用的 (写字面量或取发行版身份 DISTRIBUTION.protocol 都认) */
function claimedSchemes(): Set<string> {
  const out = new Set<string>();
  for (const m of MAIN.matchAll(/setAsDefaultProtocolClient\(\s*'([A-Za-z0-9+.-]+)'/g)) out.add(m[1]);
  if (/setAsDefaultProtocolClient\(\s*DISTRIBUTION\.protocol/.test(MAIN)) out.add(DISTRIBUTION.protocol);
  const redirect = OAUTH.match(/NEOX_REDIRECT_URI\s*=\s*'([A-Za-z0-9+.-]+):\/\//);
  if (redirect) out.add(redirect[1]);
  if (/NEOX_REDIRECT_URI\s*=\s*`\$\{DISTRIBUTION\.protocol\}:\/\//.test(OAUTH)) out.add(DISTRIBUTION.protocol);
  return out;
}

describe('neox:// 协议: 打包声明与代码认领必须一致', () => {
  it('electron-builder.json 顶层声明了本发行版的协议 (mac 的 Info.plist 靠它生成)', () => {
    expect(declaredSchemes().has(DISTRIBUTION.protocol)).toBe(true);
  });

  it('代码认领的每个 scheme 都声明了 —— 否则浏览器回调回不来', () => {
    const declared = declaredSchemes();
    for (const scheme of claimedSchemes()) {
      expect(declared.has(scheme), `${scheme}:// 代码认领了但打包配置没声明`).toBe(true);
    }
  });

  it('声明的每个 scheme 代码都处理 —— 否则点链接 app 起来但什么都不做', () => {
    const claimed = claimedSchemes();
    for (const scheme of declaredSchemes()) {
      expect(claimed.has(scheme), `${scheme}:// 声明了但代码不认`).toBe(true);
    }
  });

  it('主进程两条入口都在处理深链 (mac open-url / win second-instance)', () => {
    expect(MAIN).toContain("app.on('open-url'");
    expect(MAIN).toContain("app.on('second-instance'");
  });
});
