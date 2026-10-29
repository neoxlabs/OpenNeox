/**
 * Plugin Security — 清单校验 + 权限检查 + 文件扫描
 */

import type { PluginManifest } from '@neoxlabs/platform/shared/plugin-types.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  PLUGIN_PLATFORMS,
  declaredPlatforms,
  isPlatformSupported,
  platformLabel,
  platformsLabel,
} from '@neoxlabs/platform/shared/plugin-platform.js';
import { validateConnector } from './connector/validate.js';
import { validateExternalAgents } from './externalAgent/validate.js';

// ============================================================================
// Manifest Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const RESERVED_PREFIXES = ['neox-official-', 'private-repo-', 'system-'];
const DANGEROUS_FILE_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.com', '.msi', '.scr']);
const MAX_PLUGIN_SIZE_MB = 50;

/**
 * 校验 plugin.json 清单
 */
export function validateManifest(manifest: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 必填字段
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['plugin.json must be a valid JSON object'], warnings: [] };
  }

  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('name is required (string)');
  } else {
    if (manifest.name.length > 64) errors.push('name must be <= 64 characters');
    if (!NAME_PATTERN.test(manifest.name)) errors.push('name must be lowercase with hyphens only (e.g. "my-plugin")');
    if (RESERVED_PREFIXES.some(p => manifest.name.startsWith(p))) {
      errors.push(`name cannot start with reserved prefix: ${RESERVED_PREFIXES.join(', ')}`);
    }
  }

  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push('version is required (string, semver)');
  } else if (!VERSION_PATTERN.test(manifest.version)) {
    errors.push('version must be valid semver (e.g. "1.0.0")');
  }

  if (!manifest.description || typeof manifest.description !== 'string') {
    errors.push('description is required (string)');
  } else if (manifest.description.length > 200) {
    warnings.push('description should be <= 200 characters');
  }

  if (!manifest.author || typeof manifest.author !== 'object' || !manifest.author.name) {
    errors.push('author.name is required');
  }

  // 组件路径检查
  const pathFields = ['skills', 'tools', 'agents', 'commands'];
  for (const field of pathFields) {
    if (manifest[field]) {
      if (!Array.isArray(manifest[field])) {
        errors.push(`${field} must be an array of paths`);
      } else {
        for (const p of manifest[field]) {
          if (typeof p !== 'string') errors.push(`${field} entries must be strings`);
          else if (p.startsWith('/') || p.startsWith('..')) {
            errors.push(`${field}: "${p}" — absolute or parent paths not allowed`);
          }
        }
      }
    }
  }

  // 权限检查
  if (manifest.permissions) {
    if (manifest.permissions.filesystem?.write) {
      for (const wp of manifest.permissions.filesystem.write) {
        if (wp === '/' || wp === '~' || wp === '*') {
          errors.push(`permissions.filesystem.write: "${wp}" is too broad`);
        }
      }
    }
  }

  // 声明式 connector — 越权 / 低报副作用 / 凭据绕过全在这里挡
  if (manifest.connector !== undefined) {
    const result = validateConnector(manifest.connector);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  // 外部 Agent 委派 — 会在用户本机执行程序, 挡住让「声明式」失效的四种形态
  if (manifest.externalAgents !== undefined) {
    const result = validateExternalAgents(manifest.externalAgents);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  // 平台兼容性 —— 只校验值认不认识。**能不能在当前的系统上跑**是安装期的事,
  // 见 checkPluginPlatform (放这里会让打包器也走这条闸: 插件仓在 mac 上
  // 打一个声明 win32 的包会被误拒)。
  if (Array.isArray(manifest.platform)) {
    for (const p of manifest.platform) {
      if (!(PLUGIN_PLATFORMS as readonly string[]).includes(p)) warnings.push(`unknown platform: "${p}"`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * 清单 `engines.neox` 的安装期检查。
 *
 *   不放进 validateManifest: 打包器也走那条, 插件仓在 3.5.x 的开发机上
 *   打「要 3.7」的包会被误拒。安装路径单独拦, 打包只认清单形态。
 *
 *   只认 `>=x.y.z` / `>x.y.z` / `x.y.z`。写复杂范围就当解析失败, 宁可不装。
 */
const ENGINE_RANGE = /^(>=|>)?\s*(\d+\.\d+\.\d+)\s*$/;

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function parseNeoxEngineMinimum(range: string): { min: string; exclusive: boolean } | null {
  const m = ENGINE_RANGE.exec(range.trim());
  if (!m) return null;
  return { min: m[2], exclusive: m[1] === '>' };
}

export function satisfiesNeoxEngine(current: string, range: string): boolean {
  const parsed = parseNeoxEngineMinimum(range);
  if (!parsed) return false;
  const cmp = compareSemver(current.trim(), parsed.min);
  return parsed.exclusive ? cmp > 0 : cmp >= 0;
}

export function checkNeoxEngine(
  manifest: { engines?: { neox?: string } },
  opts?: { neoxVersion?: string },
): { ok: boolean; errors: string[]; warnings: string[] } {
  const range = typeof manifest.engines?.neox === 'string' ? manifest.engines.neox.trim() : '';
  if (!range) return { ok: true, errors: [], warnings: [] };
  if (!parseNeoxEngineMinimum(range)) {
    return { ok: false, errors: [`无法解析 engines.neox: ${range}`], warnings: [] };
  }
  const current = (opts?.neoxVersion || process.env.NEOX_APP_VERSION || '').trim();
  if (!current) {
    return {
      ok: true,
      errors: [],
      warnings: [`清单要求 Neox ${range}，当前未校验客户端版本`],
    };
  }
  if (!satisfiesNeoxEngine(current, range)) {
    return { ok: false, errors: [`需要 Neox ${range}，当前是 ${current}`], warnings: [] };
  }
  return { ok: true, errors: [], warnings: [] };
}

export function checkPluginPlatform(
  manifest: { platform?: unknown },
  opts?: { currentPlatform?: string; allowUnsupported?: boolean },
): { ok: boolean; errors: string[]; warnings: string[] } {
  const platforms = declaredPlatforms(manifest);
  const current = (opts?.currentPlatform || process.platform || '').trim();
  if (opts?.allowUnsupported) return { ok: true, errors: [], warnings: [] };
  if (isPlatformSupported(platforms, current)) return { ok: true, errors: [], warnings: [] };
  return {
    ok: false,
    errors: [
      `这个插件只支持 ${platformsLabel(platforms, false)}，不支持当前的 ${platformLabel(current, false)}`,
    ],
    warnings: [],
  };
}

/**
 * 扫描插件目录检查危险文件
 */
export async function scanPluginDirectory(pluginDir: string): Promise<string[]> {
  const issues: string[] = [];

  const scanDir = async (dir: string, depth = 0) => {
    if (depth > 10) return; // 防止深度递归
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue; // 跳过
        await scanDir(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (DANGEROUS_FILE_EXTENSIONS.has(ext)) {
          issues.push(`Dangerous file type: ${path.relative(pluginDir, fullPath)}`);
        }
      }
    }
  };

  await scanDir(pluginDir);

  // 检查总大小
  const totalSize = await getDirectorySize(pluginDir);
  if (totalSize > MAX_PLUGIN_SIZE_MB * 1024 * 1024) {
    issues.push(`Plugin size ${(totalSize / 1024 / 1024).toFixed(1)}MB exceeds limit of ${MAX_PLUGIN_SIZE_MB}MB`);
  }

  return issues;
}

/**
 * 检查插件的运行时权限
 */
export function checkRuntimePermission(
  manifest: PluginManifest,
  action: { type: 'tool'; toolName: string } | { type: 'network' } | { type: 'filesystem'; path: string; mode: 'read' | 'write' },
): boolean {
  const perms = manifest.permissions;
  if (!perms) return false;

  switch (action.type) {
    case 'tool':
      return perms.tools?.includes(action.toolName) ?? false;
    case 'network':
      return perms.network ?? false;
    case 'filesystem': {
      const paths = action.mode === 'read' ? perms.filesystem?.read : perms.filesystem?.write;
      if (!paths) return false;
      return paths.some(p => {
        if (p === '*') return true;
        return action.path.startsWith(p.replace(/\*\*$/, ''));
      });
    }
    default:
      return false;
  }
}

// ============================================================================
// Internal
// ============================================================================

async function getDirectorySize(dir: string): Promise<number> {
  let size = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        size += await getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        size += stat.size;
      }
    }
  } catch { /* ignore */ }
  return size;
}
