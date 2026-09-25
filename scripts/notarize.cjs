
exports.default = async function notarizeHook(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize] 跳过公证 — 缺 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID (本地 ad-hoc 构建正常)。');
    return;
  }

  let notarize;
  try {
    ({ notarize } = require('@electron/notarize'));
  } catch {
    console.warn('[notarize] @electron/notarize 未安装, 跳过公证。CI 真发布请先: npm i -D @electron/notarize');
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const appBundleId = packager.appInfo.id; // com.mk.neox

  console.log(`[notarize] 提交公证: ${appPath} (teamId=${teamId}) …`);
  const started = Date.now();
  await notarizeWithRetry(notarize, { tool: 'notarytool', appBundleId, appPath, appleId, appleIdPassword, teamId });
  console.log(`[notarize] 公证 + stapling 完成 (${Math.round((Date.now() - started) / 1000)}s)。`);
};

const NETWORK_ERROR_HINTS = [
  '-1001', 'timed out', 'timeout',
  '-1005', 'network connection was lost',
  '-1009', 'appears to be offline',
  'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'socket hang up',
];

function isTransientNetworkError(err) {
  const msg = String(err && (err.stack || err.message) || err);
  return NETWORK_ERROR_HINTS.some((h) => msg.toLowerCase().includes(h.toLowerCase()));
}

async function notarizeWithRetry(notarize, opts, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await notarize(opts);
      return;
    } catch (err) {
      if (i === attempts || !isTransientNetworkError(err)) throw err;
      /* 退避一下再来: Apple 那边多半已经收下了, 重提交会命中同一份并很快返回 */
      const waitMs = 30_000 * i;
      console.warn(
        `[notarize] 第 ${i}/${attempts} 次是**网络**错误 (不是公证被拒), ${waitMs / 1000}s 后重试。\n`
        + `           如果最终仍失败, 先跑一次确认它到底过没过:\n`
        + `             xcrun notarytool history --team-id ${opts.teamId} --apple-id ${opts.appleId}\n`
        + `           原始错误: ${String(err && err.message || err).split('\n')[0]}`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

module.exports.isTransientNetworkError = isTransientNetworkError;
module.exports.notarizeWithRetry = notarizeWithRetry;
