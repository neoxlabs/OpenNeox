
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const run = (cmd, args, opts = {}) =>
  execFileAsync(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts });

/** 取签名身份: 环境变量优先, 否则从钥匙串挑第一张 Developer ID Application。 */
async function resolveIdentity() {
  const fromEnv = process.env.NEOX_MAC_IDENTITY;
  if (fromEnv) return fromEnv.replace(/^Developer ID Application: /, '');

  const { stdout } = await run('security', ['find-identity', '-v', '-p', 'codesigning']);
  const m = stdout.match(/"(Developer ID Application: [^"]+)"/);
  return m ? m[1].replace(/^Developer ID Application: /, '') : null;
}

/**
 * 对单个 dmg: codesign → notarytool submit --wait → stapler staple → spctl 复验.
 * 任何一步失败都抛错 —— 这是发布链, 不许"跳过后照常成功"。
 */
async function signAndNotarizeDmg(dmgPath, identity, creds) {
  const started = Date.now();

  console.log(`[notarize-dmg] 签名 ${dmgPath} …`);
  await run('codesign', ['--sign', identity, '--timestamp', '--force', dmgPath]);

  console.log(`[notarize-dmg] 提交公证 ${dmgPath} (teamId=${creds.teamId}) …`);
  /* 网络超时 ≠ 公证被拒 —— 同 scripts/notarize.cjs 那段说明。
   * notarytool 自己也会因为 -1001 挂掉那一发, 而 Apple 侧的任务照跑。
   * 只重试网络类错误; 真被拒 (Invalid) 原样抛出去。 */
  const { notarizeWithRetry } = require('./notarize.cjs');
  const redact = (e) => {
    const scrub = (s) => String(s || '').split(creds.appleIdPassword).join('***');
    const out = new Error(scrub(e && e.message));
    out.stdout = scrub(e && e.stdout);
    out.stderr = scrub(e && e.stderr);
    out.code = e && e.code;
    return out;
  };
  await notarizeWithRetry(
    () => run('xcrun', [
      'notarytool', 'submit', dmgPath,
      '--apple-id', creds.appleId,
      '--password', creds.appleIdPassword,
      '--team-id', creds.teamId,
      '--wait',
    ]).catch((e) => { throw redact(e); }),
    { teamId: creds.teamId, appleId: creds.appleId },
  );

  console.log(`[notarize-dmg] stapling …`);
  await run('xcrun', ['stapler', 'staple', dmgPath]);

  /* 复验: 不看返回码看结论 —— spctl 接受才算数, 别信"没报错"。 */
  const { stdout, stderr } = await run('spctl', [
    '-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmgPath,
  ]).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || String(e) }));
  const verdict = `${stdout}${stderr}`;
  if (!/accepted/.test(verdict)) {
    throw new Error(`[notarize-dmg] ${dmgPath} 公证后 spctl 仍不接受:\n${verdict.trim()}`);
  }

  console.log(
    `[notarize-dmg] ✓ ${dmgPath} 完成 (${Math.round((Date.now() - started) / 1000)}s) — ${verdict.trim().split('\n').pop()}`,
  );
}

/** 主流程 — 钩子和 CLI 共用。 */
async function notarizeDmgs(dmgPaths) {
  if (dmgPaths.length === 0) return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  /* 跟 notarize.cjs 保持一致: 本地无凭据的 dev 构建静默跳过, 不破坏日常开发。
     真发布链上 desktop.sh 会自动 source apple.env, 缺了是配置问题不是常态。 */
  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize-dmg] 跳过 — 缺 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID (本地构建正常)。');
    return;
  }

  const identity = await resolveIdentity();
  if (!identity) {
    throw new Error('[notarize-dmg] 找不到 Developer ID Application 证书 —— dmg 无法签名, 发出去会被 Gatekeeper 拦。');
  }

  /* 串行 —— notarytool 并发提交同一 team 会排队, 并行只是把等待挪个地方,
     日志还会交错到看不出是哪个包失败的。 */
  for (const dmgPath of dmgPaths) {
    await signAndNotarizeDmg(dmgPath, identity, { appleId, appleIdPassword, teamId });
  }
}

/* ── electron-builder afterAllArtifactBuild 入口 ───────────────────────── */
exports.default = async function afterAllArtifactBuild(buildResult) {
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) return [];
  await notarizeDmgs(dmgs);
  return []; /* 不新增产物, 只是就地改了已有的 dmg */
};

/* ── CLI 入口 (给已出好的包补公证) ─────────────────────────────────────── */
if (require.main === module) {
  const paths = process.argv.slice(2).filter((p) => p.endsWith('.dmg'));
  if (paths.length === 0) {
    console.error('用法: node scripts/notarize-dmg.cjs <a.dmg> [b.dmg …]');
    process.exit(1);
  }
  notarizeDmgs(paths).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
