/**
 * buildCommandLine — 把 ConfigSpec (结构化启动参数) 拼成最终 shell 命令.
 *
 *   设计参照 IntelliJ Maven plugin 的 MavenExternalParameters.addMavenParameters():
 *   规则化拼接, 引号转义统一处理, 避免 agent / 用户手写 shell 字符串容易踩坑.
 *
 *   特性:
 *     · maven: 自动 -P profile, -D key=value, -DskipTests, -o (offline), -f pomFile
 *     · npm: 自动选 packageManager (npm/yarn/pnpm), -- 分割 script args
 *     · gradle: ./gradlew vs gradle 自动选, args 透传
 *     · docker-compose: -f file + up 子命令 + service 列表
 *     · python: -m module / 脚本 + args
 *
 *   不做的事:
 *     · 不拼 env 变量前缀 (NAME=value cmd) — env 走 spawn 参数, 不走命令字符串
 *     · 不加 background / fork 标记 — 这是 ProcessManager 的范畴
 *     · 不引导用户做日志重定向 (避免 stdout 流断, 跟服务面板冲突)
 */

import type { ConfigSpec } from './serviceConfigStore.js';

/** 把含空白 / 特殊字符的值用单引号包起来; 不带特殊字符直接返回. */
function shQuote(s: string): string {
  if (s === '') return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  /* 单引号内不能转义 ', 用 '\''  break-and-rejoin 模式 */
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function joinArgs(parts: string[]): string {
  return parts.filter(p => p && p.length > 0).map(shQuote).join(' ');
}

export function buildCommandLine(spec: ConfigSpec): string {
  switch (spec.kind) {
    case 'shell':
      return spec.command;

    case 'maven': {
      const parts: string[] = ['mvn'];
      /* 全局选项: -o (offline) / -f pomFile 放最前 (mvn 规范) */
      if (spec.offline) parts.push('-o');
      if (spec.pomFile) parts.push('-f', spec.pomFile);
      /* properties: -D key=value */
      if (spec.skipTests) parts.push('-DskipTests');
      if (spec.properties) {
        for (const [k, v] of Object.entries(spec.properties)) {
          if (!k) continue;
          parts.push(`-D${k}=${v}`);
        }
      }
      /* Spring profile: -Dspring-boot.run.profiles=dev,test
       * 注意跟 maven profile (-P) 不是一回事. springProfiles 让 Spring Boot 加载 application-dev.yml 等. */
      if (spec.springProfiles && spec.springProfiles.length > 0) {
        parts.push(`-Dspring-boot.run.profiles=${spec.springProfiles.join(',')}`);
      }
      /* JVM args: 包成 -Dspring-boot.run.jvmArguments="…" (仅对 spring-boot:run goal 有用,
       * 但用户可能在其它 goal 也想加; 这里统一这样拼, 跟 IDEA 行为一致). */
      if (spec.jvmArgs && spec.jvmArgs.length > 0) {
        parts.push(`-Dspring-boot.run.jvmArguments=${spec.jvmArgs.join(' ')}`);
      }
      /* goals: 列表展开 */
      parts.push(...spec.goals);
      /* Maven profiles: -P p1,p2 (跟 Spring profile 不一样, 是 maven build-time profile) */
      if (spec.profiles && spec.profiles.length > 0) {
        parts.push('-P', spec.profiles.join(','));
      }
      return joinArgs(parts);
    }

    case 'npm': {
      const pm = spec.packageManager ?? 'npm';
      /* NODE_OPTIONS prefix —— --inspect-brk=PORT / 其它 node 选项, 通过 env 注入,
       * 这样 npm/yarn/pnpm 起的子 node 进程都能继承. */
      const nodeOpts: string[] = [];
      if (typeof spec.inspectPort === 'number' && spec.inspectPort > 0) {
        nodeOpts.push(`--inspect-brk=${spec.inspectPort}`);
      }
      if (spec.nodeOptions && spec.nodeOptions.trim()) {
        nodeOpts.push(spec.nodeOptions.trim());
      }
      const parts: string[] = [];
      if (nodeOpts.length > 0) parts.push(`NODE_OPTIONS=${nodeOpts.join(' ')}`);
      parts.push(pm);
      if (pm === 'npm') {
        /* npm 需要 'run' 前缀 (除 start/test/install 等 builtin), 保守起见统一 run */
        const builtins = new Set(['start', 'test', 'install', 'ci', 'audit']);
        if (builtins.has(spec.script)) {
          parts.push(spec.script);
        } else {
          parts.push('run', spec.script);
        }
      } else {
        /* yarn / pnpm 直接接 script 名 */
        parts.push(spec.script);
      }
      if (spec.args && spec.args.length > 0) {
        if (pm === 'npm') parts.push('--', ...spec.args);
        else parts.push(...spec.args);
      }
      return joinArgs(parts);
    }

    case 'gradle': {
      const cmd = spec.useWrapper === false ? 'gradle' : './gradlew';
      const parts: string[] = [cmd];
      if (spec.properties) {
        for (const [k, v] of Object.entries(spec.properties)) {
          if (!k) continue;
          parts.push(`-P${k}=${v}`);
        }
      }
      parts.push(...spec.tasks);
      if (spec.args && spec.args.length > 0) parts.push('--args', spec.args.join(' '));
      return joinArgs(parts);
    }

    case 'docker-compose': {
      const parts: string[] = ['docker', 'compose'];
      if (spec.composeFile) parts.push('-f', spec.composeFile);
      parts.push('up');
      if (spec.detach) parts.push('-d');
      if (spec.services && spec.services.length > 0) parts.push(...spec.services);
      return joinArgs(parts);
    }

    case 'python': {
      const py = spec.interpreter ?? 'python3';
      const parts: string[] = [py];
      if (spec.module) {
        parts.push('-m', spec.module);
      } else if (spec.script) {
        parts.push(spec.script);
      }
      if (spec.args && spec.args.length > 0) parts.push(...spec.args);
      return joinArgs(parts);
    }

    case 'go': {
      /* go run <target> [-tags=...] [-ldflags=...] [-- args]
       * target 默认 '.', 跟 IDEA GoLand Run Configuration 一致 */
      const parts: string[] = ['go', 'run'];
      if (spec.tags && spec.tags.length > 0) parts.push(`-tags=${spec.tags.join(',')}`);
      if (spec.ldflags) parts.push(`-ldflags=${spec.ldflags}`);
      parts.push(spec.target || '.');
      if (spec.args && spec.args.length > 0) parts.push(...spec.args);
      return joinArgs(parts);
    }

    case 'cargo': {
      /* cargo run [--release] [--bin name | --example name] [--features ...] [-- args] */
      const parts: string[] = ['cargo', 'run'];
      if (spec.release) parts.push('--release');
      if (spec.bin) parts.push('--bin', spec.bin);
      else if (spec.example) parts.push('--example', spec.example);
      if (spec.features && spec.features.length > 0) {
        parts.push('--features', spec.features.join(','));
      }
      if (spec.args && spec.args.length > 0) parts.push('--', ...spec.args);
      return joinArgs(parts);
    }

    case 'make': {
      const parts: string[] = ['make'];
      if (spec.makefile) parts.push('-f', spec.makefile);
      if (typeof spec.jobs === 'number' && spec.jobs > 0) parts.push(`-j${spec.jobs}`);
      /* make 变量在 target 之前 (e.g. make CC=clang build), 跟 GNU Make 习惯一致 */
      if (spec.variables) {
        for (const [k, v] of Object.entries(spec.variables)) {
          if (!k) continue;
          parts.push(`${k}=${v}`);
        }
      }
      parts.push(...spec.targets);
      return joinArgs(parts);
    }

    case 'dotnet': {
      const sub = spec.command ?? 'run';
      const parts: string[] = ['dotnet', sub];
      if (spec.project) parts.push('--project', spec.project);
      if (spec.configuration) parts.push('-c', spec.configuration);
      if (spec.launchProfile) parts.push('--launch-profile', spec.launchProfile);
      if (spec.args && spec.args.length > 0) parts.push('--', ...spec.args);
      return joinArgs(parts);
    }

    case 'bun': {
      const parts: string[] = ['bun'];
      /* Bun --inspect=<port> 跟 Node inspector 兼容. spec 配后直接拼到 bun 命令里 (不走 env). */
      if (typeof spec.inspectPort === 'number' && spec.inspectPort > 0) {
        parts.push(`--inspect=${spec.inspectPort}`);
      }
      if (spec.script) {
        /* package.json script — bun run <script> */
        parts.push('run', spec.script);
      } else if (spec.entry) {
        /* 直接跑文件 — bun run index.ts (含 watch 自动判断不在这里, 由 entry 后缀决定) */
        parts.push('run', spec.entry);
      } else {
        /* 兜底, bun --help 没意义但至少不空; 实际上调用方应保证 script/entry 二选一 */
        parts.push('run');
      }
      if (spec.args && spec.args.length > 0) parts.push(...spec.args);
      return joinArgs(parts);
    }

    case 'deno': {
      const parts: string[] = ['deno'];
      if (spec.task) {
        parts.push('task', spec.task);
      } else {
        parts.push('run');
        if (spec.allowAll) {
          parts.push('--allow-all');
        } else if (spec.permissions && spec.permissions.length > 0) {
          for (const p of spec.permissions) parts.push(`--allow-${p}`);
        }
        if (spec.entry) parts.push(spec.entry);
      }
      if (spec.args && spec.args.length > 0) parts.push(...spec.args);
      return joinArgs(parts);
    }

    case 'flutter': {
      const sub = spec.command ?? 'run';
      const parts: string[] = ['flutter', sub];
      if (spec.mode === 'release') parts.push('--release');
      else if (spec.mode === 'profile') parts.push('--profile');
      /* debug 是默认, 不显式加 --debug 避免噪音 */
      if (spec.device) parts.push('-d', spec.device);
      if (spec.flavor) parts.push(`--flavor=${spec.flavor}`);
      if (spec.dartDefines) {
        for (const [k, v] of Object.entries(spec.dartDefines)) {
          if (!k) continue;
          parts.push(`--dart-define=${k}=${v}`);
        }
      }
      if (spec.args && spec.args.length > 0) parts.push(...spec.args);
      return joinArgs(parts);
    }

    default: {
      /* exhaustive check — 加新 kind 时 TS 报错提醒补 case */
      const _exhaustive: never = spec;
      throw new Error(`Unknown ConfigSpec.kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
