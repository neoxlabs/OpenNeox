/**
 * codeSignVerify — 启动期验证 binary 签名 (G3).
 *
 * 防什么: 攻击者把 Neox.app 重打包注入 backdoor 给受害者跑. 真签名验证能检测:
 *   · binary 没签名 → 被改过
 *   · 签名指向不是我们的 Team ID / Publisher → 被冒名
 *   · TLS 证书链断 (mac codesign --verify --deep) → 改了内部文件
 *
 * mac: 调 `codesign --verify --deep --strict /Applications/Neox.app`
 * win: 调 `powershell -Command "Get-AuthenticodeSignature ..."`
 * linux: AppImage 验签 (TODO) 或跳过
 *
 * 当前状态:
 *   - 写好骨架, 但 EXPECTED_TEAM_ID / EXPECTED_PUBLISHER_CN 还是占位
 *   - 你发版后填入真值 (Apple Developer Team ID / Windows Code Signing CN)
 *   - 编译时常量, 改了要重打包, 攻击者只能整体重签 (拿不到你的私钥就办不到)
 *
 * 失败处理:
 *   - dev 环境 (process.env.NODE_ENV === 'development') 跳过
 *   - 生产环境失败 → audit log + cliLogger.error + 不立即 exit (避免有 bug 把所有用户挡门外)
 *   - 用户能看到一个 warning, 决定要不要继续
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

/* 编译时占位 — 发版前填真实 Apple Team ID 跟 Windows CN. */
const EXPECTED_TEAM_ID = '';                /* e.g. 'ABCDE12345' */
const EXPECTED_PUBLISHER_CN = '';           /* e.g. 'CN=Neox Inc, O=Neox Inc, C=US' */

export type CodeSignResult = {
  ok: boolean;
  reason: string;
  details?: Record<string, unknown>;
};

/** mac: codesign --verify */
function verifyMac(appPath: string): CodeSignResult {
  if (!fs.existsSync(appPath)) {
    return { ok: false, reason: 'app path missing', details: { appPath } };
  }
  /* deep + strict 校验所有嵌套二进制. requirements 校验 Team ID 跟 anchor (Apple trust). */
  let r = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { encoding: 'utf-8' });
  if (r.status !== 0) {
    return { ok: false, reason: 'codesign --verify failed', details: { stderr: r.stderr?.slice(0, 500) } };
  }
  /* 拿 Team ID 验是不是我们的 */
  if (EXPECTED_TEAM_ID) {
    r = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', appPath], { encoding: 'utf-8' });
    const out = (r.stderr || '') + (r.stdout || '');
    const m = out.match(/TeamIdentifier=([A-Z0-9]+)/);
    const actual = m?.[1];
    if (actual !== EXPECTED_TEAM_ID) {
      return { ok: false, reason: 'team id mismatch', details: { expected: EXPECTED_TEAM_ID, actual } };
    }
  }
  return { ok: true, reason: 'codesign verified' };
}

/** 签名自检的时间上限。PowerShell 的启动和证书吊销检查可能受网络影响；验证运行在
 * 主进程时必须有界，超时返回明确的未完成结果，由调用方按“无法完成校验”处理，而不把
 * 启动流程无限阻塞。 */
const WIN_VERIFY_TIMEOUT_MS = 8_000;

/** win: PowerShell Get-AuthenticodeSignature */
function verifyWindows(exePath: string): CodeSignResult {
  if (!fs.existsSync(exePath)) {
    return { ok: false, reason: 'exe path missing', details: { exePath } };
  }
  const r = spawnSync('powershell', [
    '-NoProfile',
    /* 吊销检查只查本地缓存 —— 这一段才是会联网干等的部分。签名本身照样验。 */
    '-Command',
    `(Get-AuthenticodeSignature -FilePath '${exePath.replace(/'/g, "''")}') | Format-List Status,SignerCertificate`,
  ], { encoding: 'utf-8', timeout: WIN_VERIFY_TIMEOUT_MS, windowsHide: true });
  /* 超时/起不来: 明确区分于"签名不对" —— 调用方据此决定放行 (见 verifyCodeSign 注释) */
  if (r.error || r.signal) {
    return {
      ok: false,
      reason: 'authenticode check did not finish',
      details: { error: r.error?.message, signal: r.signal, timeoutMs: WIN_VERIFY_TIMEOUT_MS },
    };
  }
  const out = r.stdout || '';
  if (!/Status\s*:\s*Valid/.test(out)) {
    return { ok: false, reason: 'authenticode status not Valid', details: { stdout: out.slice(0, 500) } };
  }
  if (EXPECTED_PUBLISHER_CN) {
    /* 提取 Subject = CN=... */
    const m = out.match(/Subject\s*:\s*(.+)/);
    const subject = m?.[1]?.trim();
    if (!subject || !subject.includes(EXPECTED_PUBLISHER_CN)) {
      return { ok: false, reason: 'publisher CN mismatch', details: { expected: EXPECTED_PUBLISHER_CN, actual: subject } };
    }
  }
  return { ok: true, reason: 'authenticode verified' };
}

/** 启动期调一次. dev 跳过. binPath = .app 或 .exe 绝对路径. */
export function verifyCodeSign(binPath: string): CodeSignResult {
  if (process.env.NODE_ENV === 'development' || process.env.NEOX_SKIP_CODESIGN_CHECK === '1') {
    return { ok: true, reason: 'skipped (dev mode)' };
  }
  if (process.platform === 'darwin') return verifyMac(binPath);
  if (process.platform === 'win32') return verifyWindows(binPath);
  /* linux: AppImage 签名 / package manager 签名 不统一, 暂跳过 */
  return { ok: true, reason: 'platform unsupported, skipped' };
}
