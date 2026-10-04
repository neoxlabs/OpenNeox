#!/usr/bin/env node
/**
 * Vitest Windows drive-case patch（幂等）
 *
 * 背景: vitest 4.1.9/4.1.10 在 Windows 上存在双运行时实例 bug（upstream
 * vitest-dev/vitest#10812, 修复 PR #10843 尚未合入）。
 * 症状: 每条测试文件收集失败 `Cannot read properties of undefined (reading
 * 'config')`, 根源是 cmd 保留小写盘符（cd /d c:\project）, vitest 从
 * c:\... 加载而 Vite 把模块 id 归一化成 C:/... —— Node 按 URL 字符串去重,
 * 测试文件 import 到第二份运行时（runner 从未初始化）。
 *
 * 本脚本把 upstream PR #10843 的修复应用到本地编译产物, 已应用则跳过。
 * 幂等: 重复执行安全; 失败只 warn 不退出非 0（不阻塞 npm install）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'node_modules', 'vitest', 'dist', 'chunks', 'startVitestModuleRunner.CCBQZ9DQ.js');

const MARKER = '[Neox patch 2026-08-25, upstream PR vitest-dev/vitest#10843]';

// 旧代码锚点（从 dist 产物照抄）——只替换 getCachedVitestImport 的判定与 URL 构造
const OLD = `const bareVitestRegexp = /^@?vitest(?:\\/|$)/;
const normalizedDistDir = normalize(distDir);
const relativeIds = {};
const externalizeMap = /* @__PURE__ */ new Map();
// all Vitest imports always need to be externalized
function getCachedVitestImport(id, state) {
	if (id.startsWith("/@fs/") || id.startsWith("\\\\@fs\\\\")) id = id.slice(process.platform === "win32" ? 5 : 4);
	if (externalizeMap.has(id)) return {
		externalize: externalizeMap.get(id),
		type: "module"
	};
	// always externalize Vitest because we import from there before running tests
	// so we already have it cached by Node.js
	const root = state().config.root;
	const relativeRoot = relativeIds[root] ?? (relativeIds[root] = normalizedDistDir.slice(root.length));
	if (id.includes(distDir) || id.includes(normalizedDistDir)) {
		const externalize = id.startsWith("file://") ? id : pathToFileURL(id).toString();
		externalizeMap.set(id, externalize);
		return {
			externalize,
			type: "module"
		};
	}
	if (relativeRoot && relativeRoot !== "/" && id.startsWith(relativeRoot)) {
		const externalize = pathToFileURL(join(root, id)).toString();
		externalizeMap.set(id, externalize);
		return {
			externalize,
			type: "module"
		};
	}`;

const NEW = `const bareVitestRegexp = /^@?vitest(?:\\/|$)/;
const normalizedDistDir = normalize(distDir);
const relativeIds = {};
const externalizeMap = /* @__PURE__ */ new Map();
const distDirUrl = pathToFileURL(distDir).href;
const lowerDistDir = distDir.toLowerCase();
const lowerNormalizedDistDir = normalizedDistDir.toLowerCase();
const lowerDistDirUrl = distDirUrl.toLowerCase();
// ${MARKER}
// Windows paths are case-insensitive: the same file can be spelled several ways.
// \`distDir\` keeps the case the CLI was invoked with (lowercase drive letter),
// while Vite normalizes module ids to an uppercase drive. Node keys its module
// registry on the URL string, so externalizing a test file's \`vitest\` import to
// a differently spelled URL evaluates a SECOND copy of the runtime — one that
// never went through clearCollectorContext, so its module-level \`runner\` is
// undefined and the first describe() throws "Cannot read properties of
// undefined (reading 'config')". Match Vitest's own dist dir regardless of case
// and always hand back the spelling Vitest was actually loaded with.
function isVitestDistId(id) {
	if (id.includes(distDir) || id.includes(normalizedDistDir)) return true;
	if (process.platform !== "win32") return false;
	const lowerId = id.toLowerCase();
	return lowerId.includes(lowerDistDir) || lowerId.includes(lowerNormalizedDistDir) || lowerId.includes(lowerDistDirUrl);
}
function withLoadedVitestCasing(externalize) {
	if (process.platform !== "win32") return externalize;
	const index = externalize.toLowerCase().indexOf(lowerDistDirUrl);
	if (index === -1) return externalize;
	return externalize.slice(0, index) + distDirUrl + externalize.slice(index + distDirUrl.length);
}
// all Vitest imports always need to be externalized
function getCachedVitestImport(id, state) {
	if (id.startsWith("/@fs/") || id.startsWith("\\\\@fs\\\\")) id = id.slice(process.platform === "win32" ? 5 : 4);
	if (externalizeMap.has(id)) return {
		externalize: externalizeMap.get(id),
		type: "module"
	};
	// always externalize Vitest because we import from there before running tests
	// so we already have it cached by Node.js
	const root = state().config.root;
	const relativeRoot = relativeIds[root] ?? (relativeIds[root] = normalizedDistDir.slice(root.length));
	if (isVitestDistId(id)) {
		const externalize = id.startsWith("file://") ? withLoadedVitestCasing(id) : withLoadedVitestCasing(pathToFileURL(id).toString());
		externalizeMap.set(id, externalize);
		return {
			externalize,
			type: "module"
		};
	}
	if (relativeRoot && relativeRoot !== "/" && id.startsWith(relativeRoot)) {
		const externalize = withLoadedVitestCasing(pathToFileURL(join(root, id)).toString());
		externalizeMap.set(id, externalize);
		return {
			externalize,
			type: "module"
		};
	}`;

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    if (!fs.existsSync(target)) {
      console.warn('[vitest-patch] target not found, skip:', target);
      process.exit(0);
    }
    const src = fs.readFileSync(target, 'utf8');
    if (src.includes(MARKER)) {
      console.log('[vitest-patch] already applied, skip');
      process.exit(0);
    }
    if (!src.includes(OLD)) {
      console.warn('[vitest-patch] old code not found (vitest version changed?), skip');
      process.exit(0);
    }
    fs.writeFileSync(target, src.replace(OLD, NEW), 'utf8');
    console.log('[vitest-patch] applied (Windows drive-case fix, vitest#10812)');
  } catch (err) {
    console.warn('[vitest-patch] failed, not fatal:', err?.message ?? err);
  }
}

export { OLD, NEW, MARKER, target };
