#!/usr/bin/env node
/**
 * CLI R2 上传 helper — 独立于 r2-upload.mjs (那个只处理 desktop dmg/exe).
 *
 * 用法:
 *   node r2-upload-cli.mjs --version 2.4.16 --dir release/cli-publish/platforms/darwin-arm64 --arch darwin-arm64
 *
 * 做什么:
 *   1. 把 <dir>/neox (或 neox.exe) 打成 tar.gz (根目录为 package/), 上传到
 *      dl.neox-dev.com/cli/<version>/<arch>.tar.gz
 *   2. 更新 cli/latest.json: { version, updatedAt, platforms: { <arch>: <url>, ... } }
 *      只写 R2 上真实存在的平台 URL — 单平台先跑不阻塞发布, 后续平台补跑自动追加.
 *   3. 清理旧版本 tarball (保留当前版本目录 + latest.json).
 *
 * update-cmd.ts 的 selfUpdateCompiledBinary 期望 tar 里为 `package/neox`, 与本脚本 pack 结构对齐.
 *
 * R2 凭据同 r2-upload.mjs (~/.neox-secrets/r2.env):
 *   R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PUBLIC_BASE
 */

import { readFileSync, statSync, existsSync, mkdirSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

/* 与客户端 apps/cli/src/security/releaseVerify.ts canonicalJson 逐字节一致。 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** ed25519 签 {version, digests}; 私钥缺失 → 返回 null (过渡期不签, 打印警告)。 */
function signManifest(version, digests) {
  const raw = process.env.NEOX_RELEASE_SIGN_KEY;
  if (!raw) {
    console.log('  ⚠ 未设 NEOX_RELEASE_SIGN_KEY — latest.json 不带 ed25519 签名 (客户端降级为仅 sha256 校验)');
    return null;
  }
  try {
    // 支持 PEM 原文 或 base64(PEM)
    const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf-8');
    const key = createPrivateKey({ key: pem, format: 'pem' });
    const payload = Buffer.from(canonicalJson({ version, digests }), 'utf-8');
    return edSign(null, payload, key).toString('base64');
  } catch (e) {
    console.error('  ❌ 清单签名失败 (NEOX_RELEASE_SIGN_KEY 无效?):', String(e.message || e));
    process.exit(1);
  }
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const VERSION = arg('version');
const DIR = arg('dir');
const ARCH = arg('arch'); // darwin-arm64 / darwin-x64 / linux-x64 / win32-x64
if (!VERSION || !DIR || !ARCH) {
  console.error('用法: node r2-upload-cli.mjs --version <v> --dir <产物目录> --arch <platform-arch>');
  process.exit(1);
}

const ACCOUNT = process.env.R2_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET;
const BASE = (process.env.R2_PUBLIC_BASE || 'https://dl.neox-dev.com').replace(/\/$/, '') + '/cli';
if (!ACCOUNT || !BUCKET || !process.env.R2_ACCESS_KEY_ID) {
  console.error('缺 R2 凭据 (R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID)。在 ~/.neox-secrets/r2.env 配好。');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

/* 打包成 tar.gz: 里面根路径 package/neox (跟 update-cmd.ts 解压期望对齐).
 *
 * BSD tar (macOS) 没 GNU --transform, 用 staging 目录最 portable:
 *   staging/package/neox → tar -czf out.tar.gz -C staging package */
function packTarball() {
  const exe = ARCH === 'win32-x64' ? 'neox.exe' : 'neox';
  const src = path.join(DIR, exe);
  if (!existsSync(src)) throw new Error(`产物 ${src} 不存在`);

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'neox-cli-r2-'));
  try {
    const pkgDir = path.join(tmp, 'package');
    mkdirSync(pkgDir, { recursive: true });
    // 之前传 0o755(=493) → ERR_OUT_OF_RANGE. 拷完单独 chmod 755 保 binary 可执行
    // (否则 tar 记录 0644, 用户解压后 neox 不可执行). win32 的 .exe 不需要 x 位, chmod 无害.
    const stagedBin = path.join(pkgDir, exe);
    cpSync(src, stagedBin);
    try { execSync(`chmod 755 ${JSON.stringify(stagedBin)}`); } catch { /* Windows 无 chmod, 忽略 */ }
    const tarPath = path.join(tmp, `${ARCH}.tar.gz`);
    /* Win + Git-bash/MSYS tar: `C:\foo` 会被当成 host=C → "Cannot connect to C".
     * 强制本地路径 + 正斜杠, 两边 tar 都能吃. */
    const tarPathArg = process.platform === 'win32' ? tarPath.replace(/\\/g, '/') : tarPath;
    const tmpArg = process.platform === 'win32' ? tmp.replace(/\\/g, '/') : tmp;
    const forceLocal = process.platform === 'win32' ? '--force-local ' : '';
    execSync(`tar ${forceLocal}-czf ${JSON.stringify(tarPathArg)} -C ${JSON.stringify(tmpArg)} package`, { stdio: ['ignore', 'ignore', 'inherit'] });
    return { tarPath, tmp };
  } catch (err) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

async function putWithRetry(key, body, contentType, cacheControl, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: body, ContentType: contentType,
        ...(cacheControl ? { CacheControl: cacheControl } : {}),
      }));
      return;
    } catch (e) {
      if (i === attempts) throw e;
      console.log(`  ⚠ ${key} 上传失败 (${String(e.message).slice(0, 40)}), 重试 ${i}/${attempts - 1}...`);
      await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
}

async function readExistingLatest() {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'cli/latest.json' }));
    const chunks = [];
    for await (const c of r.Body) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return null;
  }
}

async function updateLatestJson(tarballKey, tarballSha256) {
  const existing = await readExistingLatest();
  const existingVersion = existing?.version;

  /* 版本升级: 新版本, 抛弃老 platforms/digests, 从零开始只记本次平台.
   * 同版本补跑其它平台: 沿用已有 map 追加 (跨机分平台发布)。 */
  const isNewer = !existingVersion || existingVersion !== VERSION;
  const platforms = isNewer ? {} : { ...(existing?.platforms || {}) };
  const digests = isNewer ? {} : { ...(existing?.digests || {}) };
  platforms[ARCH] = `${BASE}/${VERSION}/${ARCH}.tar.gz`;
  digests[ARCH] = tarballSha256;

  const signature = signManifest(VERSION, digests);

  const latest = {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    platforms,
    digests,                                    // 每平台 tarball sha256 (客户端下载后核对)
    ...(signature ? { signature, signatureKeyId: 'ed25519-v1' } : {}),
  };
  await putWithRetry(
    'cli/latest.json',
    Buffer.from(JSON.stringify(latest, null, 2)),
    'application/json',
    'no-cache,max-age=0',
  );
  const plats = Object.keys(platforms).join(', ');
  console.log(`  ✓ cli/latest.json (version=${VERSION}, 含: ${plats}${signature ? ', 已签名' : ', 未签名'})`);
}

async function cleanupOldVersions() {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'cli/' }));
  const currentPrefix = `cli/${VERSION}/`;
  for (const obj of list.Contents || []) {
    const key = obj.Key;
    if (key === 'cli/latest.json') continue;
    if (key.startsWith('cli/latest/')) continue; /* install.sh 扁平路径, 别当旧版本清掉 */
    if (key.startsWith(currentPrefix)) continue;
    /* 只清版本号目录下【本平台】的产物, 例如 cli/2.4.15/darwin-arm64.tar.gz */
    if (/^cli\/\d+\.\d+\.\d+\//.test(key) && key.endsWith(`/${ARCH}.tar.gz`)) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      console.log(`  🗑 旧版本 ${key}`);
    }
  }
}

const { tarPath, tmp } = packTarball();
try {
  const body = readFileSync(tarPath);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const key = `cli/${VERSION}/${ARCH}.tar.gz`;
  console.log(`R2 上传 CLI ${ARCH} v${VERSION} → ${BASE}/${VERSION}/${ARCH}.tar.gz`);
  console.log(`  sha256=${sha256}`);
  await putWithRetry(key, body, 'application/gzip');
  console.log(`  ↑ ${key} (${(body.length / 1048576).toFixed(1)}MB)`);
  await updateLatestJson(key, sha256);

  /* install.sh 约定扁平路径: cli/latest/neox-<os>-<arch> (非 tar).
   * ARCH=darwin-arm64 → neox-darwin-arm64; win32 → 暂不镜像 (Windows 走下载页 .exe). */
  const exe = ARCH === 'win32-x64' ? 'neox.exe' : 'neox';
  const flatSrc = path.join(DIR, exe);
  if (existsSync(flatSrc) && ARCH !== 'win32-x64') {
    const flatBody = readFileSync(flatSrc);
    const flatKey = `cli/latest/neox-${ARCH}`;
    await putWithRetry(flatKey, flatBody, 'application/octet-stream', 'no-cache,max-age=0');
    console.log(`  ↑ ${flatKey} (${(flatBody.length / 1048576).toFixed(1)}MB, install.sh)`);
  }

  await cleanupOldVersions();
  console.log(`✅ R2 完成: CLI ${ARCH} v${VERSION}`);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
