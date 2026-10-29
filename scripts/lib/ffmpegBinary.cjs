'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const RELEASE = 'b6.1.1';
const ROOT = path.resolve(__dirname, '..', '..');

function exeName(platform) {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

// 上游没出 win32-arm64 (404)。Windows 11 ARM 自带 x64 仿真, arm64 包装 x64 的 ffmpeg 照样能跑;
// win 的 afterPack 没有架构闸, mac 的闸只查 darwin 包, 不受影响
const UPSTREAM_ARCH = { 'win32-arm64': 'x64' };

/** 取 (必要时下载) 指定平台/架构的 ffmpeg, 返回本地路径。curl 认 HTTPS_PROXY (node fetch 不认)。 */
function ensureFfmpeg(platform, wantArch) {
  const arch = UPSTREAM_ARCH[`${platform}-${wantArch}`] || wantArch;
  const dir = path.join(ROOT, 'build', 'ffmpeg', `${platform}-${arch}`);
  const bin = path.join(dir, exeName(platform));
  if (fs.existsSync(bin) && fs.statSync(bin).size > 1_000_000) return bin;
  fs.mkdirSync(dir, { recursive: true });
  const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;
  const gz = `${bin}.gz`;
  console.log(`[ffmpeg] downloading ${platform}-${arch} (${RELEASE})`);
  execFileSync('curl', ['-fL', '--retry', '3', '-o', gz, `${base}/ffmpeg-${platform}-${arch}.gz`], { stdio: 'inherit' });
  fs.writeFileSync(bin, zlib.gunzipSync(fs.readFileSync(gz)));
  fs.rmSync(gz);
  execFileSync('curl', ['-fL', '--retry', '3', '-o', path.join(dir, 'ffmpeg.LICENSE'), `${base}/${platform}-${arch}.LICENSE`], { stdio: 'inherit' });
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** 拷进打好的应用: mac → <App>.app/Contents/Resources/ffmpeg/, win → resources/ffmpeg/ */
function stageFfmpegIntoApp(context) {
  const ARCH_NAMES = { 1: 'x64', 3: 'arm64' };
  const arch = ARCH_NAMES[context.arch];
  const platform = context.electronPlatformName;
  if (!arch || (platform !== 'darwin' && platform !== 'win32')) {
    throw new Error(`[ffmpeg] 不支持的打包目标 ${platform}/${context.arch} —— 视频导出会坏, 不许发`);
  }
  const src = ensureFfmpeg(platform, arch);
  let resources = path.join(context.appOutDir, 'resources');
  if (platform === 'darwin') {
    const app = fs.readdirSync(context.appOutDir).find((e) => e.endsWith('.app'));
    resources = path.join(context.appOutDir, app, 'Contents', 'Resources');
  }
  const destDir = path.join(resources, 'ffmpeg');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, exeName(platform)));
  fs.chmodSync(path.join(destDir, exeName(platform)), 0o755);
  const lic = path.join(path.dirname(src), 'ffmpeg.LICENSE');
  if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(destDir, 'ffmpeg.LICENSE'));
  console.log(`[afterPack] 🎬 ffmpeg ${platform}-${arch} → ${destDir}`);
}

module.exports = { ensureFfmpeg, stageFfmpegIntoApp, exeName };
