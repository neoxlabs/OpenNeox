/**
 * scanWorkspace — 扫工作区找出可能的 RunConfig 候选.
 *
 *   IDEA 的 "Run Anything" 体验: 用户打开项目时, IDE 自动扫 pom.xml / package.json /
 *   Dockerfile / docker-compose.yml 等, 给出"可一键启动的配置" 候选. Neox 把这个搬过来:
 *
 *     - UI: Services 面板 "+ 新建" 时, 给一组 "建议从工程扫描的 N 个配置" 让用户挑
 *     - Agent: 启动服务前先扫描, 优先用扫到的 spec, 而不是手动凑 shell 字符串
 *
 *   设计原则:
 *     · 只读, 完全 stateless, 跑多次结果一致 (idempotent)
 *     · 不写盘, 不创建 config — 调用方决定是否 upsert
 *     · 失败 silent (一个文件解析失败不影响其它), 返尽量多结果
 *     · 路径全部相对 workspaceRoot, 便于跨机器复用
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigSpec } from './serviceConfigStore.js';
import type { ScanSource } from './scanSources.js';

export interface RunConfigCandidate {
  /** 建议的 id (slug, 用户可改) */
  suggestedId: string;
  /** 建议的展示名 */
  suggestedName: string;
  /** 来源 (UI 显示用). 取值即 SCAN_SOURCES —— 加扫描器必须同步那张表, 否则 typecheck 挂. */
  source: ScanSource;
  /** 来源文件相对 workspaceRoot 的路径 */
  sourceFile: string;
  /** 结构化启动参数 */
  spec: ConfigSpec;
  /** cwd 相对 workspaceRoot (通常等于 sourceFile 所在目录) */
  cwd: string;
  /** 启发判定: 这是不是长期服务 (dev server / spring-boot 之类). UI 可优先推荐 long-lived. */
  longLived: boolean;
  /** 同一服务模块的多 profile 候选共享同一 moduleKey, UI 按它聚合成一行,
   *  行内显示 profile chips 让用户选 active. moduleKey 通常是 "<kind>:<cwd>:<baseName>". */
  moduleKey: string;
  /** 这个候选代表的 profile 名 ('dev' / 'prod' / 'test' / undefined 表示无 profile). */
  profile?: string;
}

export function scanWorkspace(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  /* 每类扫描器各自 try/catch, 单个失败不影响整体. */
  try { out.push(...scanNpm(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanMaven(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanGradle(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanDockerCompose(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanProcfile(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanGo(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanPython(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanRust(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanMakefile(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanDotnet(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanDeno(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanBun(workspaceRoot)); } catch { /* skip */ }
  try { out.push(...scanFlutter(workspaceRoot)); } catch { /* skip */ }
  /* win 适配: sourceFile 是跨机器复用的相对路径 (注释 14 行), win 的
   * path.relative 产出反斜杠 (frontend\package.json) —— 统一正斜杠, unix 上 replace 无操作。 */
  for (const c of out) c.sourceFile = c.sourceFile.replace(/\\/g, '/');
  /* 排序: long-lived 在前 (用户最关心), 然后按 sourceFile 字母序 */
  out.sort((a, b) => {
    if (a.longLived !== b.longLived) return a.longLived ? -1 : 1;
    return a.sourceFile.localeCompare(b.sourceFile);
  });
  return out;
}

/* ============================================================
 * package.json scripts → npm RunConfigCandidate
 *
 * 策略: 扫一级子目录 + 根. 每个 package.json 的 scripts 字段全列出.
 * long-lived 判定: script 名 / 内容含 dev/start/serve/watch/nodemon/vite/next 等.
 * ============================================================ */

/* Recognize only long-lived npm scripts: launch-oriented names or server
 * commands, while excluding build, test, lint, and typecheck scripts. */
const NPM_LAUNCH_NAME_PATTERN = /^(dev|start|serve|server|preview)(:|$)/i;
const NPM_LAUNCH_BODY_PATTERN = /\b(?:nodemon|vite(?:\s+(?:dev|serve|preview|--port|--host)|$)|next\s+(?:dev|start)|webpack(?:-dev-server|\s+serve)|fastify\s+start|tsx?\s+watch|http-server|live-server)\b/i;

/* 临时类 name 黑名单 — 即使 body 偶然匹配启动 pattern, 这些 name 永远不算启动 */
const NPM_NEVER_LAUNCH_NAMES = /^(build|test|lint|format|fmt|typecheck|tsc|clean|check|docs|release|publish|prepublish|deploy)(:|$)/i;

function scanNpm(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  for (const pkgPath of findFiles(workspaceRoot, 'package.json', 3)) {
    const dir = path.dirname(pkgPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    let pkg: any;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); }
    catch { continue; }
    const scripts: Record<string, string> | undefined = pkg?.scripts;
    if (!scripts || typeof scripts !== 'object') continue;
    const pm = detectPackageManager(dir);
    const moduleBaseName = rel === '.' ? (pkg?.name || 'npm') : path.basename(dir);
    /* 同 package.json 所有 script 共享一个 moduleKey, UI 聚合成一行 + script chips 切换.
     * 跟 Maven 的多 profile 一行同款体验. */
    const moduleKey = `npm:${rel}`;
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body !== 'string') continue;
      /* 黑名单优先 — name 命中黑名单永远不算启动, 不管 body 写什么 */
      if (NPM_NEVER_LAUNCH_NAMES.test(name)) continue;
      const longLived = NPM_LAUNCH_NAME_PATTERN.test(name) || NPM_LAUNCH_BODY_PATTERN.test(body);
      if (!longLived) continue;
      const sid = rel === '.' ? `npm-${name}` : `${rel.replace(/[/\\]/g, '-')}-${name}`;
      out.push({
        suggestedId: sid,
        suggestedName: moduleBaseName,  /* 不含 script 名, UI 用 chip 切换 script */
        source: 'package.json',
        sourceFile: path.relative(workspaceRoot, pkgPath),
        cwd: rel,
        spec: { kind: 'npm', script: name, packageManager: pm },
        longLived: true,
        moduleKey,
        profile: name,  /* script 名作为"变体", 跟 Spring profile 同语义复用 chip UI */
      });
    }
  }
  return out;
}

function detectPackageManager(dir: string): 'npm' | 'yarn' | 'pnpm' {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/* ============================================================
 * pom.xml → maven RunConfigCandidate
 *
 * 策略: 扫一级子目录 + 根. 每个 pom.xml 至少给一个 "mvn package" 候选;
 *   再检测是否有 spring-boot-maven-plugin → 加 "spring-boot:run" 候选 (long-lived).
 * ============================================================ */

function scanMaven(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  for (const pomPath of findFiles(workspaceRoot, 'pom.xml', 3)) {
    const dir = path.dirname(pomPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    let xml: string;
    try { xml = fs.readFileSync(pomPath, 'utf-8'); } catch { continue; }

    /* 1) 跳过 parent / aggregator pom — packaging=pom 或含 <modules>, 自己不部署. */
    if (isMavenAggregatorPom(xml)) continue;

    /* 2) 启动判定 — 必须同时满足:
     *    a. pom 显式 *激活* spring-boot-maven-plugin (剥掉 pluginManagement/dependencyManagement 后仍可见)
     *    b. src/main/java 下有 @SpringBootApplication 注解的 main class
     * 单靠 a 会把"声明在 parent pluginManagement, 子模块继承"的 lib 模块全部误判.
     * 单靠 b 慢, 我们短路: a 先 cheap reject, b 再 verify. */
    if (!hasActiveSpringBootPlugin(xml)) continue;
    if (!hasSpringBootMainClass(dir)) continue;

    const moduleName = extractMavenArtifactId(xml) || path.basename(dir);
    const sourceFile = path.relative(workspaceRoot, pomPath);

    /* 3) Spring profile 多变体 — 扫 src/main/resources/application-*.{yml,yaml,properties}
     * 每个 profile 各自一个候选, 用户挑 dev/prod/test 直接导入. 跟 IDEA Run Config 的
     * "Active profiles" 选项对齐. 没有任何 application-*.yml 文件时回退到无 profile 单候选. */
    const moduleKey = `maven:${rel}:${moduleName}`;
    const profiles = detectSpringProfiles(dir);
    if (profiles.length === 0) {
      out.push({
        suggestedId: `mvn-${moduleName}-spring-boot-run`,
        suggestedName: moduleName,
        source: 'pom.xml',
        sourceFile,
        cwd: rel,
        spec: { kind: 'maven', goals: ['spring-boot:run'], skipTests: true },
        longLived: true,
        moduleKey,
      });
    } else {
      for (const profile of profiles) {
        out.push({
          suggestedId: `mvn-${moduleName}-${profile}`,
          suggestedName: moduleName,  /* UI 端按 moduleKey 聚合, 多 profile 共用一行, name 不重复 */
          source: 'pom.xml',
          sourceFile,
          cwd: rel,
          spec: {
            kind: 'maven',
            goals: ['spring-boot:run'],
            skipTests: true,
            springProfiles: [profile],
          },
          longLived: true,
          moduleKey,
          profile,
        });
      }
    }
  }
  return out;
}

/** Parent/aggregator pom 判定 — packaging=pom 或含 <modules>, 这种 pom 自己不部署/启动. */
function isMavenAggregatorPom(xml: string): boolean {
  if (/<packaging>\s*pom\s*<\/packaging>/i.test(xml)) return true;
  if (/<modules>\s*<module>/i.test(xml)) return true;
  return false;
}

/** 剥掉 <pluginManagement> / <dependencyManagement> 块后, 再判 spring-boot-maven-plugin 是否激活.
 *  这两块里只是"声明可用版本"不算实际启用; 真正激活要在外层 <build><plugins> 出现. */
function hasActiveSpringBootPlugin(xml: string): boolean {
  const cleaned = xml
    .replace(/<pluginManagement>[\s\S]*?<\/pluginManagement>/gi, '')
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/gi, '');
  /* 严格匹配 <artifactId>spring-boot-maven-plugin</artifactId>, 不是命中字符串就算. */
  return /<artifactId>\s*spring-boot-maven-plugin\s*<\/artifactId>/i.test(cleaned);
}

/** 在模块 src/main/java 下找 @SpringBootApplication 注解的 .java 文件.
 *  只有真正带 main class 的模块才值得生成 Run Config, 否则 lib 模块会污染服务列表。
 *
 *  实现:
 *    - 只扫 src/main/java (Spring Boot 约定目录, 99% 命中)
 *    - 限制递归深度避免扫到 generated-sources 等大目录
 *    - 命中一个就立刻返回 true, 不全量扫
 *  失败 (目录不存在 / 读权限不够) 安全返 false. */
function hasSpringBootMainClass(moduleDir: string): boolean {
  const srcDir = path.join(moduleDir, 'src', 'main', 'java');
  if (!fs.existsSync(srcDir)) return false;
  return findAnnotationInDir(srcDir, /@SpringBootApplication\b/, 6);
}

function findAnnotationInDir(dir: string, pattern: RegExp, maxDepth: number): boolean {
  if (maxDepth < 0) return false;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return false; }
  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith('.java')) {
      try {
        /* 只读前 4KB — main class 文件通常很短 (< 1KB), 注解都在顶部. 加速扫描. */
        const fd = fs.openSync(path.join(dir, ent.name), 'r');
        try {
          const buf = Buffer.alloc(4096);
          const n = fs.readSync(fd, buf, 0, 4096, 0);
          if (pattern.test(buf.toString('utf-8', 0, n))) return true;
        } finally {
          fs.closeSync(fd);
        }
      } catch { /* skip unreadable file */ }
    } else if (ent.isDirectory()) {
      if (findAnnotationInDir(path.join(dir, ent.name), pattern, maxDepth - 1)) return true;
    }
  }
  return false;
}

/**
 * 扫模块 src/main/resources/ 提取 Spring profile 列表.
 *
 *   命名约定: application-<profile>.{yml,yaml,properties}
 *   只取文件名里的 profile 后缀, 不读内容 (内容里的 spring.profiles.active 用户运行时再选).
 *
 *   常见 profile: dev / test / prod / local / staging / qa. 排序时把 dev 放最前 (用户最常用).
 *   返回 [] 表示没找到 profile 文件, 调用方应回退到 "无 profile" 单候选.
 */
function detectSpringProfiles(moduleDir: string): string[] {
  const resDir = path.join(moduleDir, 'src', 'main', 'resources');
  if (!fs.existsSync(resDir)) return [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(resDir, { withFileTypes: true }); }
  catch { return []; }
  const profiles = new Set<string>();
  /* application-<profile>.<ext> — profile 命名约定: 字母/数字/连字符 */
  const RE = /^application-([\w.-]+)\.(yml|yaml|properties)$/i;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = ent.name.match(RE);
    if (m) profiles.add(m[1]);
  }
  /* dev 优先, 其它按字母排序. 这样 UI 列表里用户最常选的 dev 永远在前. */
  return [...profiles].sort((a, b) => {
    if (a === 'dev') return -1;
    if (b === 'dev') return 1;
    return a.localeCompare(b);
  });
}

function extractMavenArtifactId(xml: string): string | null {
  /* 关键修复: 先剥掉 <parent>...</parent> 内容再找 artifactId, 不然 multi-module 子 pom
   * 里 regex 拿到的是 parent.artifactId (例如 "sample-foundation"), 所有子模块都同名. */
  const head = xml.slice(0, 4000);
  const withoutParent = head.replace(/<parent>[\s\S]*?<\/parent>/i, '');
  const m = withoutParent.match(/<artifactId>\s*([\w.-]+)\s*<\/artifactId>/);
  return m ? m[1] : null;
}

/* ============================================================
 * build.gradle(.kts) → gradle RunConfigCandidate
 *
 * 简化版: 检测 spring-boot / application plugin, 给 ./gradlew bootRun 或 run 候选.
 * 不做完整 task 列表扫描 (那需要执行 gradle, 太重).
 * ============================================================ */

function scanGradle(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    for (const buildPath of findFiles(workspaceRoot, name, 3)) {
      const dir = path.dirname(buildPath);
      const rel = path.relative(workspaceRoot, dir) || '.';
      let body: string;
      try { body = fs.readFileSync(buildPath, 'utf-8'); } catch { continue; }
      const moduleName = path.basename(dir);
      const hasWrapper = fs.existsSync(path.join(dir, 'gradlew'));

      /* 只生成启动候选 (bootRun / application run); build 任务不进列表.
       * Spring Boot Gradle 也按 profile 生成多变体, 跟 Maven 一致. */
      if (/org\.springframework\.boot|spring-boot-gradle-plugin/i.test(body)) {
        const sourceFile = path.relative(workspaceRoot, buildPath);
        const moduleKey = `gradle:${rel}:${moduleName}`;
        const profiles = detectSpringProfiles(dir);
        if (profiles.length === 0) {
          out.push({
            suggestedId: `gradle-${moduleName}-bootRun`,
            suggestedName: moduleName,
            source: 'build.gradle',
            sourceFile,
            cwd: rel,
            spec: { kind: 'gradle', tasks: ['bootRun'], useWrapper: hasWrapper },
            longLived: true,
            moduleKey,
          });
        } else {
          for (const profile of profiles) {
            out.push({
              suggestedId: `gradle-${moduleName}-${profile}`,
              suggestedName: moduleName,
              source: 'build.gradle',
              sourceFile,
              cwd: rel,
              /* Gradle 没原生 springProfiles 字段, 用 -Dspring.profiles.active=X 走 properties. */
              spec: {
                kind: 'gradle',
                tasks: ['bootRun'],
                useWrapper: hasWrapper,
                properties: { 'spring.profiles.active': profile },
              },
              longLived: true,
              moduleKey,
              profile,
            });
          }
        }
      } else if (/apply\s+plugin\s*:\s*['"]application['"]|id\s*\(?\s*['"]application['"]/i.test(body)) {
        out.push({
          suggestedId: `gradle-${moduleName}-run`,
          suggestedName: moduleName,
          source: 'build.gradle',
          sourceFile: path.relative(workspaceRoot, buildPath),
          cwd: rel,
          spec: { kind: 'gradle', tasks: ['run'], useWrapper: hasWrapper },
          longLived: true,
          moduleKey: `gradle:${rel}:${moduleName}`,
        });
      }
    }
  }
  return out;
}

/* ============================================================
 * docker-compose.yml → docker-compose RunConfigCandidate
 * ============================================================ */

function scanDockerCompose(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    for (const composePath of findFiles(workspaceRoot, name, 3)) {
      const dir = path.dirname(composePath);
      const rel = path.relative(workspaceRoot, dir) || '.';
      const stem = path.basename(dir);
      out.push({
        suggestedId: `compose-${stem}`,
        suggestedName: `Docker Compose: ${stem}`,
        source: 'docker-compose.yml',
        sourceFile: path.relative(workspaceRoot, composePath),
        cwd: rel,
        spec: { kind: 'docker-compose', composeFile: name, detach: false },
        longLived: true,
        moduleKey: `docker:${rel}:${stem}`,
      });
    }
  }
  return out;
}

/* ============================================================
 * Procfile → shell RunConfigCandidate (Heroku / Foreman 风格)
 * ============================================================ */

function scanProcfile(workspaceRoot: string): RunConfigCandidate[] {
  const procfile = path.join(workspaceRoot, 'Procfile');
  if (!fs.existsSync(procfile)) return [];
  const out: RunConfigCandidate[] = [];
  let body: string;
  try { body = fs.readFileSync(procfile, 'utf-8'); } catch { return []; }
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const [, name, command] = m;
    out.push({
      suggestedId: `procfile-${name}`,
      suggestedName: `Procfile: ${name}`,
      source: 'Procfile',
      sourceFile: 'Procfile',
      cwd: '.',
      spec: { kind: 'shell', command: command.trim() },
      longLived: /^(web|worker|server|api|app)$/i.test(name),
      moduleKey: `procfile:${name}`,
    });
  }
  return out;
}

/* ============================================================
 * findFiles — 浅层递归找指定文件名 (最多 maxDepth 级)
 *
 * 跳过常见垃圾目录 (node_modules / target / build / .git / dist) 防止扫整个 monorepo
 * 卡几秒. 优先广度优先, 先返回根, 再下一级.
 * ============================================================ */

const SKIP_DIRS = new Set([
  'node_modules', 'target', 'build', '.git', '.idea', '.vscode', '.gradle',
  'dist', 'out', '.next', '.nuxt', 'coverage', '__pycache__', 'venv', '.venv',
]);

function findFiles(rootDir: string, fileName: string, maxDepth: number): string[] {
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (ent.name === fileName && ent.isFile()) {
        results.push(path.join(dir, ent.name));
      } else if (ent.isDirectory() && !SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) {
        if (depth < maxDepth) {
          queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
        }
      }
    }
  }
  return results;
}

/** glob-ish: 找 dir 下所有 *.<ext> 文件 (浅扫, maxDepth). */
function findFilesByExt(rootDir: string, ext: string, maxDepth: number): string[] {
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  const want = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (ent.isFile() && ent.name.toLowerCase().endsWith(want)) {
        results.push(path.join(dir, ent.name));
      } else if (ent.isDirectory() && !SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) {
        if (depth < maxDepth) {
          queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
        }
      }
    }
  }
  return results;
}

/** 找 dir 下满足任一 fileName 的文件 (浅扫, maxDepth). */
function findAnyFile(rootDir: string, fileNames: string[], maxDepth: number): string[] {
  const wanted = new Set(fileNames);
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (ent.isFile() && wanted.has(ent.name)) {
        results.push(path.join(dir, ent.name));
      } else if (ent.isDirectory() && !SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) {
        if (depth < maxDepth) {
          queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
        }
      }
    }
  }
  return results;
}

/* ============================================================
 * Go (go.mod) — GoLand Run Configuration 体验
 *
 * 策略:
 *   · 每个 go.mod 算一个模块 (Go modules 边界), 模块根目录是 cwd
 *   · 候选生成:
 *      - cmd/<name>/main.go (cobra/cli 多 binary 约定) → `go run ./cmd/<name>`, profile=<name>
 *      - 根目录 main.go (单 binary 项目) → `go run .`, profile='.'
 *   · 没 main.go 也没 cmd/* main.go → 不生成 (纯 library 模块)
 * ============================================================ */

function scanGo(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  for (const modPath of findFiles(workspaceRoot, 'go.mod', 3)) {
    const dir = path.dirname(modPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    const moduleName = parseGoModuleName(modPath) || path.basename(dir);
    const moduleKey = `go:${rel}`;
    const sourceFile = path.relative(workspaceRoot, modPath);
    /* (a) cmd/<name>/main.go 多 binary */
    const cmdDir = path.join(dir, 'cmd');
    if (fs.existsSync(cmdDir)) {
      let subs: fs.Dirent[] = [];
      try { subs = fs.readdirSync(cmdDir, { withFileTypes: true }); } catch { /* ignore */ }
      for (const sub of subs) {
        if (!sub.isDirectory()) continue;
        const mainGo = path.join(cmdDir, sub.name, 'main.go');
        if (!fs.existsSync(mainGo)) continue;
        out.push({
          suggestedId: `go-${path.basename(dir)}-${sub.name}`,
          suggestedName: moduleName,
          source: 'go.mod',
          sourceFile,
          cwd: rel,
          spec: { kind: 'go', target: `./cmd/${sub.name}` },
          longLived: true,
          moduleKey,
          profile: sub.name,
        });
      }
    }
    /* (b) 根 main.go — 单 binary 项目, 仅当没扫到任何 cmd binary 时才生成,
     *     避免跟 cmd/<name> 重复挂一行. */
    const rootMain = path.join(dir, 'main.go');
    const alreadyHasCmdBinary = out.some(c => c.moduleKey === moduleKey);
    if (!alreadyHasCmdBinary && fs.existsSync(rootMain)) {
      out.push({
        suggestedId: `go-${path.basename(dir)}`,
        suggestedName: moduleName,
        source: 'go.mod',
        sourceFile,
        cwd: rel,
        spec: { kind: 'go', target: '.' },
        longLived: true,
        moduleKey,
      });
    }
  }
  return out;
}

function parseGoModuleName(modPath: string): string | null {
  try {
    const head = fs.readFileSync(modPath, 'utf-8').slice(0, 4096);
    const m = head.match(/^\s*module\s+([^\s\n]+)/m);
    if (!m) return null;
    /* module github.com/foo/bar → 取最后一段 'bar' 作为友好名 */
    const last = m[1].split('/').pop();
    return last || m[1];
  } catch { return null; }
}

/* ============================================================
 * Python — PyCharm Run Configuration 体验
 *
 * 策略 (按优先级, 同模块只取最先命中那一类):
 *   1. manage.py (Django) → `python3 manage.py runserver` (long-lived)
 *   2. pyproject.toml [tool.poetry.scripts] / [project.scripts] → 每条命令一个候选
 *   3. main.py / app.py / server.py (FastAPI/Flask) → `python3 <file>`
 *
 *   FastAPI/uvicorn 检测: 文件含 `FastAPI()` 或 `app = FastAPI` → `uvicorn main:app --reload`
 * ============================================================ */

function scanPython(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];

  /* (1) Django: manage.py — 极强信号, 优先 */
  for (const mgrPath of findFiles(workspaceRoot, 'manage.py', 3)) {
    const dir = path.dirname(mgrPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    const moduleName = path.basename(dir);
    out.push({
      suggestedId: `py-${moduleName}-django`,
      suggestedName: moduleName,
      source: 'manage.py',
      sourceFile: path.relative(workspaceRoot, mgrPath),
      cwd: rel,
      spec: {
        kind: 'python',
        script: 'manage.py',
        args: ['runserver', '0.0.0.0:8000'],
      },
      longLived: true,
      moduleKey: `python:${rel}`,
      profile: 'runserver',
    });
  }

  /* (2) main.py / app.py / server.py — 入口文件约定. 每个 dir 取最高优先级一个. */
  const entryPriority: Array<{ name: string; src: 'main.py' | 'app.py' | 'main.py' }> = [
    { name: 'main.py', src: 'main.py' },
    { name: 'app.py', src: 'app.py' },
    { name: 'server.py', src: 'main.py' },
  ];
  /* 用 dir set 避免重复 */
  const seenDirs = new Set<string>();
  /* 用 manage.py 占位过的 dir 不再生成 main.py 候选, 避免一个项目两行 */
  for (const c of out) if (c.spec.kind === 'python') seenDirs.add(c.cwd);

  for (const entry of entryPriority) {
    for (const filePath of findFiles(workspaceRoot, entry.name, 3)) {
      const dir = path.dirname(filePath);
      const rel = path.relative(workspaceRoot, dir) || '.';
      if (seenDirs.has(rel)) continue;
      const moduleName = path.basename(dir);
      /* FastAPI/Flask 检测 — 决定用 uvicorn / flask CLI 还是直接 python <file> */
      const body = safeReadHead(filePath, 8192);
      const isFastApi = /FastAPI\s*\(/.test(body) || /from\s+fastapi\s+import\s+FastAPI/.test(body);
      const isFlask = /Flask\s*\(/.test(body) || /from\s+flask\s+import\s+Flask/.test(body);
      const baseName = entry.name.replace(/\.py$/, '');
      let spec: ConfigSpec;
      let profile: string;
      if (isFastApi) {
        spec = {
          kind: 'python',
          module: 'uvicorn',
          args: [`${baseName}:app`, '--reload', '--host', '0.0.0.0', '--port', '8000'],
        };
        profile = `${baseName}:app (uvicorn)`;
      } else if (isFlask) {
        spec = {
          kind: 'python',
          module: 'flask',
          args: ['--app', baseName, 'run', '--debug', '--host=0.0.0.0'],
        };
        profile = `${baseName} (flask)`;
      } else {
        spec = { kind: 'python', script: entry.name };
        profile = entry.name;
      }
      out.push({
        suggestedId: `py-${moduleName}-${baseName}`,
        suggestedName: moduleName,
        source: entry.src,
        sourceFile: path.relative(workspaceRoot, filePath),
        cwd: rel,
        spec,
        longLived: true,
        moduleKey: `python:${rel}`,
        profile,
      });
      seenDirs.add(rel);
    }
  }

  /* (3) pyproject.toml [tool.poetry.scripts] / [project.scripts] — uv / poetry script 入口 */
  for (const tomlPath of findFiles(workspaceRoot, 'pyproject.toml', 3)) {
    const dir = path.dirname(tomlPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    const moduleName = path.basename(dir);
    /* 简易 TOML 解析 — 只抓 [tool.poetry.scripts] / [project.scripts] section 内的 KEY = "..." 行.
     * 完整 TOML 解析器引入依赖太重, 我们做"够用"模式. */
    const body = safeReadHead(tomlPath, 32 * 1024);
    const scripts = parseTomlScripts(body);
    if (scripts.length === 0) continue;
    /* 同 pyproject 的 dir 已被 manage.py / main.py 占了 → 仍然追加 pyproject script 作为额外 profile.
     * UI 端按 moduleKey 聚合到同一行. */
    for (const s of scripts) {
      out.push({
        suggestedId: `py-${moduleName}-${s}`,
        suggestedName: moduleName,
        source: 'pyproject.toml',
        sourceFile: path.relative(workspaceRoot, tomlPath),
        cwd: rel,
        spec: { kind: 'python', module: s },
        longLived: /^(dev|serve|server|start|run|web|api)$/i.test(s),
        moduleKey: `python:${rel}`,
        profile: s,
      });
    }
  }

  return out;
}

/** 极简 TOML 抽取: 找 [tool.poetry.scripts] / [project.scripts] section 里的 key = "..." 列表.
 *  只返 key 名 (script 名), 不解析值. */
function parseTomlScripts(toml: string): string[] {
  const out: string[] = [];
  const sectionRe = /^\s*\[(tool\.poetry\.scripts|project\.scripts)\]\s*$/m;
  const m = toml.match(sectionRe);
  if (!m) return out;
  const startIdx = m.index! + m[0].length;
  /* section body: 直到下一个 [section] 或文件尾 */
  const rest = toml.slice(startIdx);
  const endMatch = rest.match(/^\s*\[[^\]]+\]\s*$/m);
  const body = endMatch ? rest.slice(0, endMatch.index!) : rest;
  for (const line of body.split(/\r?\n/)) {
    const lm = line.match(/^\s*([A-Za-z][\w.-]*)\s*=\s*['"]/);
    if (lm) out.push(lm[1]);
  }
  return out;
}

function safeReadHead(filePath: string, bytes: number): string {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.toString('utf-8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch { return ''; }
}

/* ============================================================
 * Rust (Cargo.toml) — RustRover / cargo run 体验
 *
 * 策略:
 *   · 每个 Cargo.toml 一个模块 (workspace member 各自一行)
 *   · 跳过 workspace 根 (含 [workspace] 没 [package])
 *   · 候选生成:
 *      - [[bin]] 多 binary → 每个 bin 一个候选, profile=bin name
 *      - src/main.rs (默认 binary) → cargo run, profile='default'
 *      - 都没 (只有 src/lib.rs) → library crate, 不生成
 * ============================================================ */

function scanRust(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  for (const cargoPath of findFiles(workspaceRoot, 'Cargo.toml', 3)) {
    const dir = path.dirname(cargoPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    const body = safeReadHead(cargoPath, 16 * 1024);
    /* workspace 根 — 仅含 [workspace] 没 [package], 跳过 */
    const hasPackage = /^\s*\[package\]/m.test(body);
    if (!hasPackage) continue;
    const cargoName = extractTomlValue(body, /^\s*\[package\][\s\S]*?^\s*name\s*=\s*['"]([^'"]+)['"]/m);
    const moduleName = cargoName || path.basename(dir);
    const moduleKey = `cargo:${rel}`;
    const sourceFile = path.relative(workspaceRoot, cargoPath);
    /* (a) [[bin]] 多 binary */
    const bins = parseCargoBins(body);
    for (const bin of bins) {
      out.push({
        suggestedId: `cargo-${moduleName}-${bin}`,
        suggestedName: moduleName,
        source: 'Cargo.toml',
        sourceFile,
        cwd: rel,
        spec: { kind: 'cargo', bin },
        longLived: true,
        moduleKey,
        profile: bin,
      });
    }
    /* (b) src/main.rs 默认 binary — 只在没显式 [[bin]] 时生成, 避免跟显式 bin 重复 */
    if (bins.length === 0 && fs.existsSync(path.join(dir, 'src', 'main.rs'))) {
      out.push({
        suggestedId: `cargo-${moduleName}`,
        suggestedName: moduleName,
        source: 'Cargo.toml',
        sourceFile,
        cwd: rel,
        spec: { kind: 'cargo' },
        longLived: true,
        moduleKey,
      });
    }
  }
  return out;
}

/** 解析 Cargo.toml 里所有 [[bin]] section 的 name 字段. */
function parseCargoBins(toml: string): string[] {
  const out: string[] = [];
  /* [[bin]] section 可有多个, 每个 section 直到下个 [ 开头. */
  const re = /^\s*\[\[bin\]\]\s*$([\s\S]*?)(?=^\s*\[)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(toml + '\n[end]')) !== null) {
    const body = m[1];
    const nm = body.match(/^\s*name\s*=\s*['"]([^'"]+)['"]/m);
    if (nm) out.push(nm[1]);
  }
  return out;
}

function extractTomlValue(toml: string, re: RegExp): string | null {
  const m = toml.match(re);
  return m ? m[1] : null;
}

/* ============================================================
 * Makefile — make Run Configuration 体验
 *
 * 策略:
 *   · 每个 Makefile 一个模块, 解析 target 名
 *   · 只保留 launch 类 target (run/dev/serve/start/watch/up); build/test/clean 排除 (临时类)
 *   · target 名 = profile (UI chip)
 *
 * Makefile target 语法: ^<name>:<deps> 或 ^<name>:\n\t<recipe>
 *   排除 .PHONY: / include / 变量赋值
 * ============================================================ */

const MAKE_LAUNCH_PATTERN = /^(dev|develop|run|start|serve|server|watch|up)(-[\w.-]+)?$/i;
const MAKE_NEVER_LAUNCH = /^(build|test|clean|install|all|lint|fmt|format|check|deploy|release|help|docs?)(:|$)/i;

function scanMakefile(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  for (const mkPath of findFiles(workspaceRoot, 'Makefile', 3)) {
    const dir = path.dirname(mkPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    const moduleName = path.basename(dir);
    const body = safeReadHead(mkPath, 64 * 1024);
    const targets = parseMakeTargets(body);
    const moduleKey = `make:${rel}`;
    const sourceFile = path.relative(workspaceRoot, mkPath);
    for (const t of targets) {
      if (MAKE_NEVER_LAUNCH.test(t)) continue;
      if (!MAKE_LAUNCH_PATTERN.test(t)) continue;
      out.push({
        suggestedId: `make-${moduleName}-${t}`,
        suggestedName: moduleName,
        source: 'Makefile',
        sourceFile,
        cwd: rel,
        spec: { kind: 'make', targets: [t] },
        longLived: true,
        moduleKey,
        profile: t,
      });
    }
  }
  return out;
}

function parseMakeTargets(makefile: string): string[] {
  const out = new Set<string>();
  for (const line of makefile.split(/\r?\n/)) {
    /* 跳过空 / 注释 / recipe (tab 开头) / 变量赋值 / .PHONY */
    if (!line || line.startsWith('\t') || line.startsWith('#')) continue;
    if (/^\s*(include|sinclude|-include|\.PHONY|ifeq|ifneq|ifdef|else|endif)\b/.test(line)) continue;
    if (/^\s*[A-Za-z_][\w.-]*\s*[?+:]?=/.test(line)) continue;  /* 变量 */
    /* 真 target: NAME: deps (NAME 不能含 = $) */
    const m = line.match(/^\s*([A-Za-z][\w.-]*)\s*:\s*(?!=)/);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/* ============================================================
 * .NET (.csproj / .fsproj) — Rider Run Configuration 体验
 *
 * 策略:
 *   · 扫所有 .csproj/.fsproj
 *   · 只保留 OutputType=Exe 或 Sdk=Microsoft.NET.Sdk.Web (可执行/web app)
 *   · Library (默认 OutputType=Library) 跳过
 * ============================================================ */

function scanDotnet(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  const csprojs = [
    ...findFilesByExt(workspaceRoot, '.csproj', 3),
    ...findFilesByExt(workspaceRoot, '.fsproj', 3),
  ];
  for (const projPath of csprojs) {
    const dir = path.dirname(projPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    const projName = path.basename(projPath).replace(/\.[cf]sproj$/i, '');
    const body = safeReadHead(projPath, 16 * 1024);
    /* Sdk="Microsoft.NET.Sdk.Web" → 一定可跑 */
    const isWebSdk = /<Project[^>]*Sdk\s*=\s*['"]Microsoft\.NET\.Sdk\.Web['"]/i.test(body);
    /* OutputType=Exe → 可跑 */
    const isExe = /<OutputType>\s*Exe\s*<\/OutputType>/i.test(body);
    /* OutputType 没声明 + Sdk 是 Microsoft.NET.Sdk (default) → 默认 Library, 跳过.
     * 但 .NET Console 模板默认是 Sdk=Microsoft.NET.Sdk + OutputType=Exe 显式, 上面已经覆盖. */
    if (!isWebSdk && !isExe) continue;
    out.push({
      suggestedId: `dotnet-${projName}`,
      suggestedName: projName,
      source: 'csproj',
      sourceFile: path.relative(workspaceRoot, projPath),
      cwd: rel,
      spec: { kind: 'dotnet', project: path.basename(projPath), command: 'run' },
      longLived: true,
      moduleKey: `dotnet:${rel}:${projName}`,
    });
  }
  return out;
}

/* ============================================================
 * Deno (deno.json / deno.jsonc) — Deno tasks
 *
 * 策略:
 *   · deno.json 里 "tasks": { "dev": "...", "start": "..." } 全列出
 *   · launch 类 (dev/start/serve/preview) → long-lived; 其它 false
 * ============================================================ */

function scanDeno(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  for (const denoPath of findAnyFile(workspaceRoot, ['deno.json', 'deno.jsonc'], 3)) {
    const dir = path.dirname(denoPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    const moduleName = path.basename(dir);
    const body = safeReadHead(denoPath, 32 * 1024);
    /* jsonc 注释剥掉再 parse */
    const cleaned = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    let json: any;
    try { json = JSON.parse(cleaned); } catch { continue; }
    const tasks: Record<string, string> | undefined = json?.tasks;
    if (!tasks || typeof tasks !== 'object') continue;
    const moduleKey = `deno:${rel}`;
    for (const [name, body2] of Object.entries(tasks)) {
      if (typeof body2 !== 'string') continue;
      if (NPM_NEVER_LAUNCH_NAMES.test(name)) continue;
      const longLived = /^(dev|start|serve|server|preview|watch)(:|$)/i.test(name)
        || /\b(deno\s+run|--watch|--allow-net)\b/.test(body2);
      if (!longLived) continue;
      out.push({
        suggestedId: `deno-${moduleName}-${name}`,
        suggestedName: moduleName,
        source: 'deno.json',
        sourceFile: path.relative(workspaceRoot, denoPath),
        cwd: rel,
        spec: { kind: 'deno', task: name },
        longLived: true,
        moduleKey,
        profile: name,
      });
    }
  }
  return out;
}

/* ============================================================
 * Bun — bunfig.toml / bun.lockb 标识的 Bun 项目
 *
 * 策略:
 *   · 已经被 scanNpm 覆盖 (Bun 也读 package.json scripts), 这里只针对"没有 package.json 但有 bunfig 或 bun.lockb"
 *     的纯 Bun 项目: 扫根 index.ts / server.ts 入口
 *   · 同 dir 有 package.json 时让 npm scanner 处理 (能选 packageManager='bun' UI 上加)
 * ============================================================ */

function scanBun(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  const markers = findAnyFile(workspaceRoot, ['bunfig.toml', 'bun.lockb'], 3);
  for (const markerPath of markers) {
    const dir = path.dirname(markerPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    /* 同 dir 有 package.json → 已被 scanNpm 接管 (UI 端 packageManager 字段可改 bun) */
    if (fs.existsSync(path.join(dir, 'package.json'))) continue;
    const moduleName = path.basename(dir);
    /* 找入口 .ts/.js 文件 */
    const ENTRY_CANDIDATES = ['index.ts', 'index.tsx', 'index.js', 'server.ts', 'server.js', 'main.ts'];
    for (const entry of ENTRY_CANDIDATES) {
      const entryPath = path.join(dir, entry);
      if (!fs.existsSync(entryPath)) continue;
      out.push({
        suggestedId: `bun-${moduleName}-${entry.replace(/\..+$/, '')}`,
        suggestedName: moduleName,
        source: 'bunfig.toml',
        sourceFile: path.relative(workspaceRoot, markerPath),
        cwd: rel,
        spec: { kind: 'bun', entry },
        longLived: true,
        moduleKey: `bun:${rel}`,
        profile: entry,
      });
      break;  /* 同 dir 只生一个入口候选, 优先级按列表顺序 */
    }
  }
  return out;
}

/* ============================================================
 * Flutter (pubspec.yaml 含 flutter: 块)
 *
 * 策略:
 *   · pubspec.yaml 有 `flutter:` 顶级 key → Flutter app
 *   · 没 flutter: 块 (纯 Dart package) 不生成 run config
 * ============================================================ */

function scanFlutter(workspaceRoot: string): RunConfigCandidate[] {
  const out: RunConfigCandidate[] = [];
  for (const pubPath of findFiles(workspaceRoot, 'pubspec.yaml', 3)) {
    const dir = path.dirname(pubPath);
    const rel = path.relative(workspaceRoot, dir) || '.';
    const body = safeReadHead(pubPath, 32 * 1024);
    /* 顶级 flutter: key (不能是子层缩进的 'flutter' 字符串) */
    if (!/^flutter\s*:/m.test(body)) continue;
    const nameMatch = body.match(/^\s*name\s*:\s*([\w.-]+)/m);
    const moduleName = nameMatch ? nameMatch[1] : path.basename(dir);
    out.push({
      suggestedId: `flutter-${moduleName}`,
      suggestedName: moduleName,
      source: 'pubspec.yaml',
      sourceFile: path.relative(workspaceRoot, pubPath),
      cwd: rel,
      spec: { kind: 'flutter', command: 'run' },
      longLived: true,
      moduleKey: `flutter:${rel}`,
    });
  }
  return out;
}
