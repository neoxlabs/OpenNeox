#!/usr/bin/env node

/**
 * 自动版本管理脚本
 * - 检查当前版本是否已在 npm 上发布
 * - 如果已发布,自动递增补丁版本
 * - 更新 package.json 并创建 git commit 和 tag
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const PACKAGE_NAME = '@neoxlabs/cli';

/**
 * 执行命令并返回输出
 */
function exec(command, options = {}) {
  try {
    const result = execSync(command, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options
    });
    return result ? result.trim() : '';
  } catch (error) {
    if (options.ignoreError) {
      return '';
    }
    throw error;
  }
}

/**
 * 检查版本是否已在 npm 上发布
 */
function isVersionPublished(version) {
  try {
    const output = exec(`npm view ${PACKAGE_NAME}@${version} version`, {
      silent: true,
      ignoreError: true
    });
    return output === version;
  } catch {
    return false;
  }
}

/**
 * 递增版本号
 */
function incrementVersion(version, type = 'patch') {
  const [major, minor, patch] = version.split('.').map(Number);

  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

/**
 * 更新 package.json 中的版本号
 */
function updatePackageVersion(newVersion) {
  const packagePath = join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.version = newVersion;
  writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
}

/**
 * 主函数
 */
async function main() {
  const versionType = process.argv[2] || 'patch'; // patch, minor, major

  console.log('🔍 检查当前版本状态...');

  // 读取当前版本
  const packagePath = join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  let currentVersion = packageJson.version;

  console.log(`📦 当前版本: ${currentVersion}`);

  // 检查当前版本是否已发布
  if (isVersionPublished(currentVersion)) {
    console.log(`⚠️  版本 ${currentVersion} 已在 npm 上发布`);
    console.log(`🔄 自动递增 ${versionType} 版本...`);

    // 递增版本号
    const newVersion = incrementVersion(currentVersion, versionType);
    console.log(`✨ 新版本: ${newVersion}`);

    // 更新 package.json
    updatePackageVersion(newVersion);
    currentVersion = newVersion;

    // 配置 git 用户信息 (CI 环境需要)
    exec('git config user.name "GitHub Actions"', { ignoreError: true });
    exec('git config user.email "github-actions[bot]@users.noreply.github.com"', { ignoreError: true });

    // 提交更改
    exec('git add package.json');
    exec(`git commit -m "chore: bump version to ${newVersion}"`);

    console.log('✅ 版本已更新');
  } else {
    console.log(`✅ 版本 ${currentVersion} 尚未发布,可以继续`);
  }

  // 创建或更新 git tag
  const tagName = `v${currentVersion}`;
  console.log(`🏷️  创建标签: ${tagName}`);

  // 删除本地标签(如果存在)
  exec(`git tag -d ${tagName}`, { ignoreError: true, silent: true });

  // 创建新标签
  exec(`git tag ${tagName}`);

  console.log(`\n🎉 版本管理完成!`);
  console.log(`   版本号: ${currentVersion}`);
  console.log(`   标签: ${tagName}`);

  // 输出到 GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('fs');
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${currentVersion}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tagName}\n`);
  }
}

main().catch((error) => {
  console.error('❌ 错误:', error.message);
  process.exit(1);
});
