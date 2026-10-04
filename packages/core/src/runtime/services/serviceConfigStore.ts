/**
 * ServiceConfigStore — workspace-级 ServiceConfig 持久化 (.neox/run-configs.json).
 *
 *   ServiceConfig 是用户 / agent 在工作区里"声明"的可运行服务条目, 类似 IDEA Run Config
 *   或 Procfile 一行. 跟着 git 走 (默认 .neox/ 不进 gitignore, 团队共享).
 *
 *   命名: 跟运行时进程层 (ProcessManager) 区分 — RunConfig/ServiceConfig 是"声明",
 *   ProcessManager 里的 TrackedProcess 是"运行实例". 两者通过 configId 关联.
 *
 *   注: 文件名仍叫 run-configs.json (跟 IDEA 同名, 用户认知更顺), 内部类型/类名用 Service*
 *   避免跟 utils/runConfigStore.ts (AI worker 模型配置, 完全不同概念) 撞名.
 *
 *   失败策略:
 *     读: 文件不存在 / JSON 坏 → 返空列表, log warn, 不阻塞
 *     写: 失败 throw, 调用方决定是否提示
 */

import * as fs from 'node:fs';
import { normalizeWorkspaceRoot } from '@neoxlabs/platform/platform/processTree.js';
import * as path from 'node:path';
import { buildCommandLine } from './buildCommandLine.js';

export type ConfigSpec =
  | { kind: 'shell'; command: string }
  | {
      kind: 'maven';
      goals: string[];                     /* e.g. ['clean', 'install', 'spring-boot:run'] */
      profiles?: string[];                 /* -P profile1,profile2 (Maven profile, 不是 Spring profile) */
      springProfiles?: string[];           /* -Dspring-boot.run.profiles=dev,test (Spring Boot 专用) */
      properties?: Record<string, string>; /* -D key=value 表 (UI table 编辑) */
      jvmArgs?: string[];                  /* -Dspring-boot.run.jvmArguments="..." 内部值 */
      pomFile?: string;                    /* -f xxx/pom.xml, 默认当前 cwd 的 pom.xml */
      offline?: boolean;                   /* -o */
      skipTests?: boolean;                 /* -DskipTests */
    }
  | {
      kind: 'npm';
      script: string;                       /* package.json scripts 的 key (e.g. "dev") */
      packageManager?: 'npm' | 'yarn' | 'pnpm';
      args?: string[];                      /* 透传给 script 的参数 (npm run dev -- --port 3000) */
      env?: Record<string, string>;
      inspectPort?: number;
      /** 透传给 node 本身的参数 (--max-old-space-size=4096 等), 通过 NODE_OPTIONS 注入 */
      nodeOptions?: string;
    }
  | {
      kind: 'gradle';
      tasks: string[];                      /* e.g. ['bootRun'], ['build'] */
      properties?: Record<string, string>;
      args?: string[];
      useWrapper?: boolean;                 /* ./gradlew vs system gradle */
    }
  | {
      kind: 'docker-compose';
      services?: string[];                  /* 指定 service 名, 不传起所有 */
      composeFile?: string;                 /* -f docker-compose.yml, 默认 cwd 的 */
      detach?: boolean;                     /* up -d */
    }
  | {
      kind: 'python';
      module?: string;                      /* python -m <module> e.g. "http.server" */
      script?: string;                      /* python xxx.py */
      args?: string[];
      interpreter?: string;                 /* 默认 'python3' */
      /** Django/FastAPI 等 sub-command 用 — 直接拼到脚本/module 后, e.g. ['runserver', '0.0.0.0:8000'] */
    }
  | {
      kind: 'go';
      /** go run 目标: 包路径 (e.g. './cmd/server') 或文件 (e.g. 'main.go'). 默认 '.'. */
      target?: string;
      /** go build/run 标签 -tags="..." */
      tags?: string[];
      /** -ldflags="..." */
      ldflags?: string;
      /** 透传给被运行程序的参数 — go run target -- args */
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      kind: 'cargo';
      /** cargo run --bin <name> 的 bin 名; 不传走默认 src/main.rs */
      bin?: string;
      /** cargo run --example <name> */
      example?: string;
      /** --release */
      release?: boolean;
      /** --features="a,b" */
      features?: string[];
      /** 透传给被运行程序: cargo run -- args */
      args?: string[];
    }
  | {
      kind: 'make';
      /** make <target1> <target2> */
      targets: string[];
      /** -f Makefile.dev */
      makefile?: string;
      /** -j8 并行 */
      jobs?: number;
      /** VAR=value (make variables) */
      variables?: Record<string, string>;
    }
  | {
      kind: 'dotnet';
      /** Project file path (.csproj / .fsproj). 不传走 cwd 自动找. */
      project?: string;
      /** dotnet run / build / test / watch (默认 run) */
      command?: 'run' | 'build' | 'test' | 'watch';
      /** -c Debug / Release */
      configuration?: 'Debug' | 'Release';
      /** --launch-profile (launchSettings.json 里的 profile) */
      launchProfile?: string;
      /** 透传给被运行程序: dotnet run -- args */
      args?: string[];
    }
  | {
      kind: 'bun';
      /** package.json script 名 (bun run dev) — 或裸文件 (bun index.ts) 走 script + entry 二选一 */
      script?: string;
      /** 直接跑文件: bun run index.ts */
      entry?: string;
      args?: string[];
      env?: Record<string, string>;
      /** Bun 也兼容 Node inspector — 设了之后启动前注入 BUN_INSPECT (bun --inspect=<port>) */
      inspectPort?: number;
    }
  | {
      kind: 'deno';
      /** deno.json tasks 里的 task 名 (deno task dev) */
      task?: string;
      /** 直接跑文件: deno run --allow-net main.ts */
      entry?: string;
      /** --allow-net, --allow-read 等权限 flag (无前缀, 数组 ['net','read']) */
      permissions?: string[];
      /** --allow-all 一把梭 */
      allowAll?: boolean;
      args?: string[];
    }
  | {
      kind: 'flutter';
      /** flutter run / build / test (默认 run) */
      command?: 'run' | 'build' | 'test';
      /** -d <device> (chrome/macos/<emulator-id>) */
      device?: string;
      /** --flavor=<name> */
      flavor?: string;
      /** --dart-define=K=V */
      dartDefines?: Record<string, string>;
      /** --release / --profile / --debug (默认 debug) */
      mode?: 'debug' | 'profile' | 'release';
      args?: string[];
    };

export interface ServiceConfig {
  id: string;
  name: string;
  /** 最终启动命令. 老格式只有这个字段 (扁平 shell 字符串).
   *  新格式 spec 存在时由 buildCommandLine(spec) 派生填入, 二者一致, command 仍是
   *  权威 (P0 一致性 + 老代码无感知). */
  command: string;
  /** 结构化启动参数 (P1+). 可选, 老配置没有这个字段不影响. */
  spec?: ConfigSpec;
  cwd: string;            /* 绝对路径或相对 workspaceRoot 的路径 */
  env?: Record<string, string>;
  port?: number;
  /** healthcheck 配置, P2 用. P1 阶段先保留字段不实装. */
  healthcheck?: {
    kind: 'http' | 'port' | 'log_pattern';
    target: string;
    timeoutMs?: number;
  };
  /** 起来后自动开 web surface (localhost:${port}) */
  autoOpenSurface?: boolean;
  /** P3-3: 崩溃自愈 — opt-in. 非 0 退出且开了 autoRestart → serviceRestartManager
   *  自动重启. 退避: 10s 窗口内连续 3 次失败放弃 (避免无限循环).
   *  用户主动 stop (UI 按钮 / bash_kill) **不**触发自愈, 那是显式行为. */
  autoRestart?: boolean;
  /** sidebar 钉住, 排在前面 */
  pinned?: boolean;
  group?: string;
  /** 组内启动顺序 (小的先起)。组启动按序串行: 配了 healthcheck 的等 healthy 再起下一个,
   *  没配的等到端口出现或短暂延时。缺省按创建时间兜底。 */
  startOrder?: number;
  createdBy: 'user' | 'agent';
  createdAt: number;
  updatedAt?: number;
}

interface FileShape {
  version: number;
  configs: ServiceConfig[];
}

const CURRENT_VERSION = 1;
const FILE_REL = '.neox/run-configs.json';

function resolveFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, FILE_REL);
}

export class ServiceConfigStore {
  private workspaceRoot: string;
  /** in-memory cache — 读盘一次, 写盘后刷新. 同一进程多个调用方共享同一 store 实例时复用. */
  private cache: ServiceConfig[] | null = null;
  /** 缓存对应的文件 mtime — 用于检测外部改动(脏读防御)。0 = 无文件 / 未读盘。 */
  private cachedMtimeMs = 0;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /** 读取文件 mtime, 文件不存在返回 0。 */
  private statMtime(filePath: string): number {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** 列出所有 ServiceConfig. 文件不存在 → 空数组. */
  list(): ServiceConfig[] {
    const filePath = resolveFilePath(this.workspaceRoot);

    // 脏读防御:即便有 cache, 也廉价 stat 一次。外部进程(或用户手改 run-configs.json)
    // 改动文件后 mtime 变化 → 失效重读, 避免拿到过期配置。stat 是 sync 轻操作。
    if (this.cache !== null) {
      const currentMtime = this.statMtime(filePath);
      if (currentMtime === this.cachedMtimeMs) {
        return this.cache;
      }
      // mtime 不一致(外部改动 / 文件被删) → 失效, 落到下面重读
      this.cache = null;
    }

    if (!fs.existsSync(filePath)) {
      this.cache = [];
      this.cachedMtimeMs = 0;
      return this.cache;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      this.cachedMtimeMs = this.statMtime(filePath);
      const parsed = JSON.parse(raw) as Partial<FileShape>;
      if (Array.isArray(parsed?.configs)) {
        this.cache = parsed.configs.filter(c => c && typeof c.id === 'string' && typeof c.command === 'string');
      } else {
        this.cache = [];
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[ServiceConfigStore] 解析 ${filePath} 失败, 当空配置处理:`, err);
      this.cache = [];
    }
    return this.cache;
  }

  /** 按 id 取. */
  get(id: string): ServiceConfig | undefined {
    return this.list().find(c => c.id === id);
  }

  /** 按 command + cwd 匹配 RunConfig — 用于 execute_shell 自动 bindConfig.
   *
   *   两层匹配:
   *     1. 严格 normalize-match (空白塌缩) — 配置 command 跟进程 command 完全一致.
   *     2. fuzzy match — agent 经常凑出比 RunConfig 多 -D / jvmArguments 的命令
   *        (e.g. config 是 `mvn -DskipTests -Dspring-boot.run.profiles=dev spring-boot:run`,
   *        agent 实际跑 `mvn spring-boot:run -Dspring-boot.run.profiles=dev -Dspring-boot.run.jvmArguments=...
   *        -Dlogging.file.name=... -Dspring.cloud.nacos.discovery.fail-fast=false`).
   *        严格匹配字符串永远命不中, agent 起的进程就被错判成 ad-hoc. fuzzy 看"主工具
   *        + 关键标识"(maven goal / spring profile / npm script / gradle task), 进程是
   *        config 的"超集" (含 config 的全部关键字段) 就算命中.
   *
   *   严格优先 fuzzy — 一个工作区可能多个 RunConfig 走同一工具, fuzzy 更宽松反而冲突.
   *   只在严格没命中时才回退 fuzzy. */
  findByCommandCwd(command: string, cwd: string): ServiceConfig | undefined {
    const normCmd = command.trim().replace(/\s+/g, ' ');
    const normCwd = normalizeWorkspaceRoot(path.resolve(this.workspaceRoot, cwd));
    const cfgCwd = (c: ServiceConfig) => normalizeWorkspaceRoot(path.resolve(this.workspaceRoot, c.cwd));
    /* layer 1: 严格 */
    const strict = this.list().find(c => {
      const cCmd = c.command.trim().replace(/\s+/g, ' ');
      return cCmd === normCmd && cfgCwd(c) === normCwd;
    });
    if (strict) return strict;
    /* layer 2: fuzzy (cwd 同 + signature 是 config 的超集) */
    const procSig = extractCommandSignature(normCmd);
    if (procSig.tool === 'unknown') return undefined;
    return this.list().find(c => {
      if (cfgCwd(c) !== normCwd) return false;
      const cfgSig = extractCommandSignature(c.command.trim().replace(/\s+/g, ' '));
      return signatureSuperset(procSig, cfgSig);
    });
  }

  /**
   * 新建或覆盖一个 ServiceConfig (按 id upsert).
   *   id 已存在 → 替换 (updatedAt 刷新, createdAt 保留)
   *   id 不存在 → 添加
   * 返回最终 ServiceConfig.
   */
  upsert(input: Omit<ServiceConfig, 'createdAt' | 'updatedAt' | 'command'> & {
    /** 老格式: 直接给 command 字符串 */
    command?: string;
  } & Partial<Pick<ServiceConfig, 'createdAt' | 'updatedAt'>>): ServiceConfig {
    if (!input.id || typeof input.id !== 'string') throw new Error('ServiceConfig.id 必填');
    if (!input.cwd || typeof input.cwd !== 'string') throw new Error('ServiceConfig.cwd 必填');
    if (input.createdBy !== 'user' && input.createdBy !== 'agent') {
      throw new Error('ServiceConfig.createdBy 必须是 user 或 agent');
    }

    /* command 派生策略 (新 P1 模型):
     *   · 有 spec → buildCommandLine(spec) 派生 command (单一权威源)
     *   · 无 spec + 有 command → 老格式, 直接用
     *   · 都没 → 报错
     * 双源都存在时以 spec 为准, command 重新生成 (避免不一致). */
    let finalCommand: string;
    if (input.spec) {
      finalCommand = buildCommandLine(input.spec);
    } else if (input.command) {
      finalCommand = input.command;
    } else {
      throw new Error('ServiceConfig 必须提供 spec 或 command');
    }

    const now = Date.now();
    const existing = this.list().find(c => c.id === input.id);
    const final: ServiceConfig = {
      ...input,
      command: finalCommand,
      name: input.name || input.id,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) {
      this.cache = this.list().map(c => c.id === input.id ? final : c);
    } else {
      this.cache = [...this.list(), final];
    }
    this.flush();
    return final;
  }

  /** 按 id 删. 不存在静默返 false. */
  remove(id: string): boolean {
    const before = this.list();
    const after = before.filter(c => c.id !== id);
    if (after.length === before.length) return false;
    this.cache = after;
    this.flush();
    return true;
  }

  /** 强制重读 (用于测试 / 外部改 file 后). */
  invalidate(): void {
    this.cache = null;
    this.cachedMtimeMs = 0;
  }

  private flush(): void {
    const filePath = resolveFilePath(this.workspaceRoot);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const data: FileShape = { version: CURRENT_VERSION, configs: this.list() };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    // 写盘后同步 mtime — 否则下次 list() 会把"自己刚写的"误判成外部改动而重读。
    this.cachedMtimeMs = this.statMtime(filePath);
  }
}

/* ============================================================
 * 命令"签名"提取 — 把一段 shell command 抽成可比较的结构化指纹.
 *
 *   场景: agent 凭语言模型现凑的 `mvn spring-boot:run -Dspring-boot.run.profiles=dev -Dspring-boot.run.jvmArguments="-Xms256m -Xmx512m" -Dlogging.file.name=...`
 *   要跟工作区里已有的 `mvn -DskipTests -Dspring-boot.run.profiles=dev spring-boot:run`
 *   认成同一服务 — 字符串完全不一样, 但 (mvn, spring-boot:run, profile=dev) 这个语义指纹一样.
 *
 *   实现策略:
 *     · 按主工具切类: maven / gradle / npm-like / docker-compose / unknown
 *     · 提取该工具的"关键身份标识" — goals / tasks / script / springProfiles / services
 *     · 忽略风险低的辅助参数 (jvmArguments / logging.file.name / -X / -P 普通 profile 等)
 *     · 留下 maven build-time profile (-P) 也算关键, 因为同模块不同 profile 是不同 RunConfig
 *
 *   两个签名"超集"判定 = 进程签名包含 config 签名的全部关键标识 + 工具相同. config 的标识
 *   都在进程命令里出现 → 这个进程是 config 描述的服务. 进程额外的 -D 字段不否定这一点.
 * ============================================================ */

export type CommandSignature =
  | { tool: 'maven'; goals: Set<string>; profiles: Set<string>; springProfiles: Set<string> }
  | { tool: 'gradle'; tasks: Set<string> }
  | { tool: 'npm' | 'yarn' | 'pnpm'; script: string | null }
  | { tool: 'docker-compose'; services: Set<string> }
  | { tool: 'unknown' };

/** 把一段 shell command 切成 token, 兼顾单/双引号 — 简易版, 不做 shell escape. */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/** 剥掉 env prefix (`KEY=val NEXT=val cmd ...`) + cd prefix (`cd path && cmd ...`). */
function stripCommandPrefixes(cmd: string): string {
  let s = cmd.trim();
  /* cd /xxx && real-cmd */
  const cdM = s.match(/^cd\s+\S+\s+&&\s+(.+)$/);
  if (cdM) s = cdM[1].trim();
  /* KEY=VAL ... 前缀 (env 变量) — 一直剥到第一个非 KEY=VAL 的 token */
  while (true) {
    const envM = s.match(/^[A-Za-z_][A-Za-z0-9_]*=/);
    if (!envM) break;
    /* 找下一个空格, 跳过 KEY=val (可能含引号) */
    const sp = s.indexOf(' ');
    if (sp < 0) break;
    s = s.slice(sp + 1).trim();
  }
  return s;
}

export function extractCommandSignature(rawCmd: string): CommandSignature {
  const cmd = stripCommandPrefixes(rawCmd);
  const toks = tokenize(cmd);
  if (toks.length === 0) return { tool: 'unknown' };
  const head = toks[0];
  const rest = toks.slice(1);

  /* ===== Maven ===== */
  if (/^(?:mvn|\.\/mvnw|mvnw)$/.test(head)) {
    const goals = new Set<string>();
    const profiles = new Set<string>();
    const springProfiles = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === '-P' && rest[i + 1]) {
        for (const p of rest[++i].split(',')) profiles.add(p.trim());
      } else if (t.startsWith('-P') && t.length > 2) {
        for (const p of t.slice(2).split(',')) profiles.add(p.trim());
      } else if (t.startsWith('-Dspring-boot.run.profiles=')) {
        for (const p of t.slice('-Dspring-boot.run.profiles='.length).split(',')) springProfiles.add(p.trim());
      } else if (t.startsWith('-')) {
        /* 其它 -D... / -X / -o / -f 等都不算身份标识, 跳过 */
        continue;
      } else if (t.length > 0) {
        /* goal — clean / install / spring-boot:run / package 等 */
        goals.add(t);
      }
    }
    return { tool: 'maven', goals, profiles, springProfiles };
  }

  /* ===== Gradle / gradlew ===== */
  if (/^(?:\.\/gradlew|gradle|gradlew)$/.test(head)) {
    const tasks = new Set<string>();
    for (const t of rest) {
      if (t.startsWith('-')) continue;
      tasks.add(t);
    }
    return { tool: 'gradle', tasks };
  }

  /* ===== npm / yarn / pnpm ===== */
  if (head === 'npm' || head === 'yarn' || head === 'pnpm') {
    /* npm run <script> / npm <builtin> / yarn <script> / pnpm <script> */
    let script: string | null = null;
    if (head === 'npm') {
      if (rest[0] === 'run' && rest[1]) script = rest[1];
      else if (rest[0] && !rest[0].startsWith('-')) script = rest[0];
    } else {
      if (rest[0] === 'run' && rest[1]) script = rest[1];
      else if (rest[0] && !rest[0].startsWith('-')) script = rest[0];
    }
    return { tool: head, script };
  }

  /* ===== docker compose ===== */
  if (head === 'docker' && rest[0] === 'compose') {
    const services = new Set<string>();
    let pastUp = false;
    for (let i = 1; i < rest.length; i++) {
      const t = rest[i];
      if (t === 'up') { pastUp = true; continue; }
      if (!pastUp) continue;
      if (t.startsWith('-')) continue;
      services.add(t);
    }
    return { tool: 'docker-compose', services };
  }

  return { tool: 'unknown' };
}

/** 进程签名是 config 签名的超集 — 进程命令包含 config 的全部关键标识. */
export function signatureSuperset(proc: CommandSignature, cfg: CommandSignature): boolean {
  if (proc.tool !== cfg.tool) return false;
  switch (proc.tool) {
    case 'maven': {
      const c = cfg as Extract<CommandSignature, { tool: 'maven' }>;
      return setSuperset(proc.goals, c.goals)
        && setSuperset(proc.profiles, c.profiles)
        && setSuperset(proc.springProfiles, c.springProfiles);
    }
    case 'gradle': {
      const c = cfg as Extract<CommandSignature, { tool: 'gradle' }>;
      return setSuperset(proc.tasks, c.tasks);
    }
    case 'npm':
    case 'yarn':
    case 'pnpm': {
      const c = cfg as Extract<CommandSignature, { tool: 'npm' | 'yarn' | 'pnpm' }>;
      /* 同工具同 script (任一为空时不匹配, 避免 'npm install' 误绑 'npm run dev') */
      return !!proc.script && proc.script === c.script;
    }
    case 'docker-compose': {
      const c = cfg as Extract<CommandSignature, { tool: 'docker-compose' }>;
      return setSuperset(proc.services, c.services);
    }
    default:
      return false;
  }
}

function setSuperset<T>(big: Set<T>, small: Set<T>): boolean {
  for (const v of small) if (!big.has(v)) return false;
  return true;
}
