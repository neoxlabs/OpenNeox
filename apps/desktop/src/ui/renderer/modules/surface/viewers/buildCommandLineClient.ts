/**
 * buildCommandLineClient — 前端版的 buildCommandLine, 给 NewConfigForm 实时预览用.
 *
 * 后端 (neox-core/runtime/services/buildCommandLine.ts) 是权威源 — 保存时还是它说了算.
 * 这里复刻一份是因为前端不能直接 import core (Electron renderer 跨进程边界), 而预览必须
 * 实时同步, 不适合走 IPC. 两边逻辑保持一致, 改一边时记得同步另一边.
 *
 * 一致性测试: 这里写的是 ground truth 的子集, 缺失的高级字段 (jvmArgs 等) 在前端简化.
 */

export type ConfigSpec =
  | { kind: 'shell'; command: string }
  | {
      kind: 'maven';
      goals: string[];
      profiles?: string[];
      springProfiles?: string[];
      properties?: Record<string, string>;
      jvmArgs?: string[];
      pomFile?: string;
      offline?: boolean;
      skipTests?: boolean;
      /** 多模块工程里要跑的子模块 (相对聚合根), 跟后端 MavenSpec.module 一致 */
      module?: string;
    }
  | {
      kind: 'npm';
      script: string;
      packageManager?: 'npm' | 'yarn' | 'pnpm';
      args?: string[];
      env?: Record<string, string>;
      inspectPort?: number;
      nodeOptions?: string;
    }
  | {
      kind: 'gradle';
      tasks: string[];
      properties?: Record<string, string>;
      args?: string[];
      useWrapper?: boolean;
    }
  | {
      kind: 'docker-compose';
      services?: string[];
      composeFile?: string;
      detach?: boolean;
    }
  | {
      kind: 'python';
      module?: string;
      script?: string;
      args?: string[];
      interpreter?: string;
    }
  | {
      kind: 'go';
      target?: string;
      tags?: string[];
      ldflags?: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      kind: 'cargo';
      bin?: string;
      example?: string;
      release?: boolean;
      features?: string[];
      args?: string[];
    }
  | {
      kind: 'make';
      targets: string[];
      makefile?: string;
      jobs?: number;
      variables?: Record<string, string>;
    }
  | {
      kind: 'dotnet';
      project?: string;
      command?: 'run' | 'build' | 'test' | 'watch';
      configuration?: 'Debug' | 'Release';
      launchProfile?: string;
      args?: string[];
    }
  | {
      kind: 'bun';
      script?: string;
      entry?: string;
      args?: string[];
      env?: Record<string, string>;
      inspectPort?: number;
    }
  | {
      kind: 'deno';
      task?: string;
      entry?: string;
      permissions?: string[];
      allowAll?: boolean;
      args?: string[];
    }
  | {
      kind: 'flutter';
      command?: 'run' | 'build' | 'test';
      device?: string;
      flavor?: string;
      dartDefines?: Record<string, string>;
      mode?: 'debug' | 'profile' | 'release';
      args?: string[];
    };

function shQuote(s: string): string {
  if (s === '') return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function joinArgs(parts: string[]): string {
  return parts.filter(p => p && p.length > 0).map(shQuote).join(' ');
}

export function buildCommandLine(spec: ConfigSpec): string {
  switch (spec.kind) {
    case 'shell':
      return spec.command || '';

    case 'maven': {
      const parts: string[] = ['mvn'];
      if (spec.offline) parts.push('-o');
      if (spec.pomFile) parts.push('-f', spec.pomFile);
      if (spec.skipTests) parts.push('-DskipTests');
      if (spec.properties) {
        for (const [k, v] of Object.entries(spec.properties)) {
          if (!k) continue;
          parts.push(`-D${k}=${v}`);
        }
      }
      if (spec.springProfiles && spec.springProfiles.length > 0) {
        parts.push(`-Dspring-boot.run.profiles=${spec.springProfiles.join(',')}`);
      }
      if (spec.jvmArgs && spec.jvmArgs.length > 0) {
        parts.push(`-Dspring-boot.run.jvmArguments=${spec.jvmArgs.join(' ')}`);
      }
      parts.push(...(spec.goals || []));
      if (spec.profiles && spec.profiles.length > 0) {
        parts.push('-P', spec.profiles.join(','));
      }
      if (!spec.module) return joinArgs(parts);
      /* 多模块: 先装依赖的兄弟模块, 再只跑这一个 (同后端) */
      const pre: string[] = ['mvn'];
      if (spec.offline) pre.push('-o');
      if (spec.pomFile) pre.push('-f', spec.pomFile);
      pre.push('-q', '-pl', spec.module, '-am', 'install', '-DskipTests');
      const goalAt = spec.goals.length > 0 ? parts.indexOf(spec.goals[0]) : -1;
      if (goalAt >= 0) parts.splice(goalAt, 0, '-pl', spec.module);
      else parts.push('-pl', spec.module);
      return `${joinArgs(pre)} && ${joinArgs(parts)}`;
    }

    case 'npm': {
      const pm = spec.packageManager ?? 'npm';
      const nodeOpts: string[] = [];
      if (typeof spec.inspectPort === 'number' && spec.inspectPort > 0) {
        nodeOpts.push(`--inspect-brk=${spec.inspectPort}`);
      }
      if (spec.nodeOptions && spec.nodeOptions.trim()) nodeOpts.push(spec.nodeOptions.trim());
      const parts: string[] = [];
      if (nodeOpts.length > 0) parts.push(`NODE_OPTIONS=${nodeOpts.join(' ')}`);
      parts.push(pm);
      if (pm === 'npm') {
        const builtins = new Set(['start', 'test', 'install', 'ci', 'audit']);
        if (builtins.has(spec.script)) parts.push(spec.script);
        else parts.push('run', spec.script);
      } else {
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
      parts.push(...(spec.tasks || []));
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
      const py = spec.interpreter || 'python3';
      const parts: string[] = [py];
      if (spec.module) parts.push('-m', spec.module);
      else if (spec.script) parts.push(spec.script);
      if (spec.args && spec.args.length > 0) parts.push(...spec.args);
      return joinArgs(parts);
    }

    case 'go': {
      const parts: string[] = ['go', 'run'];
      if (spec.tags && spec.tags.length > 0) parts.push(`-tags=${spec.tags.join(',')}`);
      if (spec.ldflags) parts.push(`-ldflags=${spec.ldflags}`);
      parts.push(spec.target || '.');
      if (spec.args && spec.args.length > 0) parts.push(...spec.args);
      return joinArgs(parts);
    }

    case 'cargo': {
      const parts: string[] = ['cargo', 'run'];
      if (spec.release) parts.push('--release');
      if (spec.bin) parts.push('--bin', spec.bin);
      else if (spec.example) parts.push('--example', spec.example);
      if (spec.features && spec.features.length > 0) parts.push('--features', spec.features.join(','));
      if (spec.args && spec.args.length > 0) parts.push('--', ...spec.args);
      return joinArgs(parts);
    }

    case 'make': {
      const parts: string[] = ['make'];
      if (spec.makefile) parts.push('-f', spec.makefile);
      if (typeof spec.jobs === 'number' && spec.jobs > 0) parts.push(`-j${spec.jobs}`);
      if (spec.variables) {
        for (const [k, v] of Object.entries(spec.variables)) {
          if (!k) continue;
          parts.push(`${k}=${v}`);
        }
      }
      parts.push(...(spec.targets || []));
      return joinArgs(parts);
    }

    case 'dotnet': {
      const sub = spec.command || 'run';
      const parts: string[] = ['dotnet', sub];
      if (spec.project) parts.push('--project', spec.project);
      if (spec.configuration) parts.push('-c', spec.configuration);
      if (spec.launchProfile) parts.push('--launch-profile', spec.launchProfile);
      if (spec.args && spec.args.length > 0) parts.push('--', ...spec.args);
      return joinArgs(parts);
    }

    case 'bun': {
      const parts: string[] = ['bun'];
      if (typeof spec.inspectPort === 'number' && spec.inspectPort > 0) {
        parts.push(`--inspect=${spec.inspectPort}`);
      }
      if (spec.script) parts.push('run', spec.script);
      else if (spec.entry) parts.push('run', spec.entry);
      else parts.push('run');
      if (spec.args && spec.args.length > 0) parts.push(...spec.args);
      return joinArgs(parts);
    }

    case 'deno': {
      const parts: string[] = ['deno'];
      if (spec.task) {
        parts.push('task', spec.task);
      } else {
        parts.push('run');
        if (spec.allowAll) parts.push('--allow-all');
        else if (spec.permissions && spec.permissions.length > 0) {
          for (const p of spec.permissions) parts.push(`--allow-${p}`);
        }
        if (spec.entry) parts.push(spec.entry);
      }
      if (spec.args && spec.args.length > 0) parts.push(...spec.args);
      return joinArgs(parts);
    }

    case 'flutter': {
      const sub = spec.command || 'run';
      const parts: string[] = ['flutter', sub];
      if (spec.mode === 'release') parts.push('--release');
      else if (spec.mode === 'profile') parts.push('--profile');
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

    default:
      return '';
  }
}
