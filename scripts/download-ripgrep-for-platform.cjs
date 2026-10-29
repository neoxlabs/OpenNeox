#!/usr/bin/env node
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const VERSION = 'v15.0.0';
const GITHUB_REPO = 'https://github.com/microsoft/ripgrep-prebuilt/releases/download';

const args = process.argv.slice(2);
let targetPlatform = null;
let targetArch = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--platform' && args[i + 1]) targetPlatform = args[++i];
  if (args[i] === '--arch' && args[i + 1]) targetArch = args[++i];
}

if (!targetPlatform || !targetArch) {
  console.log('Usage: node download-ripgrep-for-platform.cjs --platform <win32|linux|darwin> --arch <x64|arm64>');
  console.log('\nThis script downloads the ripgrep binary for cross-platform Electron packaging.');
  console.log('Run this before "npx electron-builder" when building for a different platform.\n');
  process.exit(0);
}

function getTarget(platform, arch) {
  const mapping = {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
  };
  return mapping[`${platform}-${arch}`];
}

function getExtension(platform) {
  return platform === 'win32' ? '.zip' : '.tar.gz';
}

const target = getTarget(targetPlatform, targetArch);
if (!target) {
  console.error(`Unsupported platform/arch: ${targetPlatform}/${targetArch}`);
  process.exit(1);
}

const ext = getExtension(targetPlatform);
const url = `${GITHUB_REPO}/${VERSION}/ripgrep-${VERSION}-${target}${ext}`;
const binDir = path.join(__dirname, '..', 'node_modules', '@vscode', 'ripgrep', 'bin');
const rgBin = targetPlatform === 'win32' ? 'rg.exe' : 'rg';

console.log(`📦 Downloading ripgrep ${VERSION} for ${targetPlatform}/${targetArch}...`);
console.log(`   Target: ${target}`);
console.log(`   URL: ${url}`);
console.log(`   Dest: ${path.join(binDir, rgBin)}`);

// 确保 bin 目录存在
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

// 清理现有二进制
const existingRg = path.join(binDir, 'rg');
const existingRgExe = path.join(binDir, 'rg.exe');
if (fs.existsSync(existingRg)) fs.unlinkSync(existingRg);
if (fs.existsSync(existingRgExe)) fs.unlinkSync(existingRgExe);

// 下载并解压
const tmpFile = path.join(os.tmpdir(), `ripgrep-${target}${ext}`);

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  try {
    await downloadFile(url, tmpFile);
    console.log(`   Downloaded: ${(fs.statSync(tmpFile).size / 1024 / 1024).toFixed(1)} MB`);

    if (ext === '.zip') {
      // Windows zip
      execSync(`unzip -o "${tmpFile}" -d "${binDir}"`, { stdio: 'pipe' });
    } else {
      // Unix tar.gz
      execSync(`tar xzf "${tmpFile}" -C "${binDir}"`, { stdio: 'pipe' });
    }

    const finalPath = path.join(binDir, rgBin);
    if (!fs.existsSync(finalPath)) {
      // 可能解压到了子目录
      const entries = fs.readdirSync(binDir);
      for (const entry of entries) {
        const subDir = path.join(binDir, entry);
        if (fs.statSync(subDir).isDirectory()) {
          const subRg = path.join(subDir, rgBin);
          if (fs.existsSync(subRg)) {
            fs.renameSync(subRg, finalPath);
            fs.rmdirSync(subDir, { recursive: true });
            break;
          }
        }
      }
    }

    if (fs.existsSync(finalPath)) {
      if (targetPlatform !== 'win32') {
        fs.chmodSync(finalPath, 0o755);
      }
      console.log(`✅ ripgrep ${VERSION} for ${targetPlatform}/${targetArch} ready at ${finalPath}`);
    } else {
      console.error('❌ Failed to extract ripgrep binary');
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Failed to download ripgrep: ${err.message}`);
    process.exit(1);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

main();
