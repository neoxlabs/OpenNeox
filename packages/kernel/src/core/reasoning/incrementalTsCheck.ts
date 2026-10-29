/**
 * incrementalTsCheck — 只对改动文件跑 TypeScript 检查 (VERIFY-05)
 *
 * 现状: AutoVerifyPipeline 的 TS 验证器跑的是 `tsc --noEmit` 全量项目检查,
 * 大仓一次几十秒, 撞上 8 秒超时就直接跳过 —— 等于没验。
 *
 * 这里的做法: 从改动文件往上找最近的 tsconfig, 生成一份**临时 tsconfig**,
 * 继承项目配置 (compilerOptions / paths / types 全部沿用), 只把 `files` 收窄到
 * 这一个文件, `include` 置空, 再让 tsc 检查这一份配置。
 *
 * 为什么临时配置要写在项目目录里:
 *   `types: ["node"]` / `typeRoots` 是相对**配置文件所在目录**往上找 node_modules 的。
 *   放到 os.tmpdir() 里就找不到 node_modules, 会冒出一堆假的 "Cannot find module"。
 *   所以写在 tsconfig 旁边, 用完立刻删。
 *
 * 只查改动文件本身及其依赖 (tsc 会顺着 import 拉进依赖), 无关文件的错误不会被报出来。
 */

import fs from 'fs';
import path from 'path';

export interface TsCheckPlan {
    /** 可直接交给 execSync 的完整命令 */
    command: string;
    /** 临时配置路径 (调试用) */
    configPath: string;
    /** 用完必须调用 —— 删掉临时配置 */
    cleanup: () => void;
}

/** 从改动文件往上找最近的 tsconfig; 走出 workspace 就停 */
export function findNearestTsconfig(filePath: string, workDir: string): string | null {
    const root = path.resolve(workDir);
    let dir = path.dirname(path.resolve(filePath));

    for (let i = 0; i < 16; i++) {
        if (dir !== root && !dir.startsWith(root + path.sep)) return null;
        for (const name of ['tsconfig.json', 'tsconfig.build.json']) {
            const candidate = path.join(dir, name);
            if (fs.existsSync(candidate)) return candidate;
        }
        if (dir === root) return null;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

/** 找本地 typescript 的 tsc —— 不走 `npx tsc` (那会在没装 typescript 的项目里触发下载) */
export function resolveTscBinary(workDir: string): string | null {
    let dir = path.resolve(workDir);
    for (let i = 0; i < 10; i++) {
        for (const name of ['tsc', 'tsc.cmd']) {
            const bin = path.join(dir, 'node_modules', '.bin', name);
            if (fs.existsSync(bin)) return bin;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

let seq = 0;

/**
 * 生成单文件检查计划。找不到 tsconfig / tsc 时返回 null (调用方按"检查器不可用"跳过)。
 */
export function buildSingleFileTsCheckPlan(
    filePath: string,
    workDir: string,
    options: { tscBinary?: string } = {},
): TsCheckPlan | null {
    const absFile = path.resolve(filePath);
    const tsconfig = findNearestTsconfig(absFile, workDir);
    if (!tsconfig) return null;

    const tsc = options.tscBinary ?? resolveTscBinary(workDir);
    /* 路径不存在就别生成命令 —— execSync 会因 ENOENT 抛错, 输出为空会被当成"通过" */
    if (!tsc || !fs.existsSync(tsc)) return null;

    const configDir = path.dirname(tsconfig);
    const rel = (p: string): string => {
        const r = path.relative(configDir, p) || '.';
        return r.split(path.sep).join('/');
    };
    const relFile = rel(absFile);

    const tmpPath = path.join(configDir, `.neox-verify-${process.pid}-${Date.now()}-${seq++}.json`);
    const ext = path.extname(absFile).toLowerCase();
    const config = {
        extends: `./${path.basename(tsconfig)}`,
        files: [relFile.startsWith('.') ? relFile : `./${relFile}`],
        /* 继承来的 include 会把它重新放大成全量检查, 必须清空 */
        include: [],
        compilerOptions: {
            noEmit: true,
            /* rootDir 跟着 workspace 放宽, 避免"文件不在 rootDir 下"的假错误 */
            rootDir: rel(path.resolve(workDir)),
            composite: false,
            incremental: false,
            declaration: false,
            declarationMap: false,
            emitDeclarationOnly: false,
            /* .js/.jsx 文件在没开 allowJs 的项目里会被 tsc 直接拒掉 (TS6054),
             * 这里只补上"能读"这一项, 不改变项目的类型检查强度 */
            ...(['.js', '.jsx', '.mjs', '.cjs'].includes(ext) ? { allowJs: true } : {}),
        },
    };

    try {
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch {
        return null;
    }

    return {
        configPath: tmpPath,
        command: `"${tsc}" -p "${tmpPath}" --pretty false 2>&1 | head -30`,
        cleanup: () => {
            try {
                fs.unlinkSync(tmpPath);
            } catch {
                /* 已经被删 / 被清理掉了 */
            }
        },
    };
}
