/**
 * deriveFriendlyName — 从 shell 命令推断语义化短名.
 *
 *   agent 起的 shell 命令通常是 "cd /xxx && mvn spring-boot:run -P dev" 这种长串.
 *   直接当列表显示名又长又丑, 截断后 "cd /Users/.../backend/..." 完全看不出是什么服务.
 *
 *   服务列表要的是一眼能认出的名字: "Spring Boot" / "MallApplication" / "Docker".
 *   命令细节留给 hover tooltip / 详情面板, 列表行只放这个模块反推出来的短名.
 *
 *   优先级:
 *     1. 用户给的别名 (configName) → 最权威
 *     2. spec.kind + 关键字段 (P1 结构化 RunConfig 走这条)
 *     3. 命令字符串 pattern 匹配 (agent 用 shell 起的 ad-hoc 进程走这条)
 *     4. fallback: 命令首个 word
 *
 *   设计原则: 输出短 (< 30 字符), 优先动词式描述用户能识别的服务类型 ("Spring Boot",
 *   "HTTP Server :8888", "Vite Dev Server") 而不是 "java" / "mvn" 这种二进制名.
 */

export interface FriendlyNameInput {
  command: string;
  /** 用户在 RunConfig 里取的别名, 最高优先级 */
  configName?: string;
  /** 从 stdout 嗅探出的真实启动类名 (Spring Boot "Started XxxApplication in N seconds" 等).
   *  比 command pattern 派生的泛泛 "Spring Boot" 更精确, 多服务场景能区分开. */
  refinedName?: string;
  /** 早期 ProcessManager.deriveDisplayName 派生的 — 比 command 短但还是丑, 仅作 fallback */
  legacyDisplayName?: string;
}

export function deriveFriendlyName(input: FriendlyNameInput): string {
  if (input.configName && input.configName.trim()) return input.configName.trim();
  if (input.refinedName && input.refinedName.trim()) return input.refinedName.trim();

  const stripped = stripCdPrefix(input.command);
  const friendly = parseCommandPattern(stripped);
  if (friendly) return friendly;

  /* legacy display name (含 env prefix 已剥掉 + 路径已砍) 比 raw command 好, 用它兜底 */
  if (input.legacyDisplayName && !input.legacyDisplayName.startsWith('cd ')) {
    return input.legacyDisplayName;
  }

  /* 最差兜底: 取命令第一个 word */
  const first = stripped.trim().split(/\s+/)[0] || 'Process';
  return first.split('/').pop() || first;
}

/**
 * "cd /xxx && real-cmd" → "real-cmd".
 *
 * `cd` 支持 Windows `/d`、`--`、带引号路径和多层命令链；剥离这些前缀后再识别真正的
 * 服务命令，避免工作目录命令掩盖显示名称。
 */
function stripCdPrefix(cmd: string): string {
  let out = cmd.trim();
  /* 多层 `cd a && cd b && real` 也剥干净; 加个上限防病态输入 */
  for (let i = 0; i < 4; i++) {
    const m = out.match(/^cd\s+(?:\/[a-zA-Z]\s+)?(?:--\s+)?(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*(.+)$/);
    if (!m) break;
    out = m[1].trim();
  }
  return out;
}

/** 按命令 pattern 推断 friendly name. 返回 undefined 表示没命中. */
function parseCommandPattern(cmd: string): string | undefined {
  /* ===== Java/JVM 生态 ===== */

  // mvn spring-boot:run / 嵌套在 mvn 命令里的 spring-boot:run goal
  if (/\bspring-boot:run\b/i.test(cmd)) return 'Spring Boot';

  // mvn -Pdev clean install / mvn package
  const mvnMatch = cmd.match(/^mvn\s+(?:-\S+\s+)*([^\s-]\S*)/);
  if (mvnMatch) return `Maven: ${mvnMatch[1]}`;

  // ./gradlew bootRun / gradle bootRun
  if (/^(?:\.\/gradlew|gradle)\s+(?:-\S+\s+)*bootRun\b/i.test(cmd)) return 'Spring Boot';

  // ./gradlew <task>
  const gradleMatch = cmd.match(/^(?:\.\/gradlew|gradle)\s+(?:-\S+\s+)*([^\s-]\S*)/);
  if (gradleMatch) return `Gradle: ${gradleMatch[1]}`;

  // java -jar app.jar / java -Xms -jar
  const javaJarMatch = cmd.match(/\bjava\s+(?:-\S+\s+)*-jar\s+(\S+)/i);
  if (javaJarMatch) {
    const jarName = javaJarMatch[1].split('/').pop()?.replace(/\.jar$/, '') || 'java';
    return `Java: ${jarName}`;
  }

  /* ===== Node.js 生态 ===== */

  // npm run <script>
  const npmRunMatch = cmd.match(/^npm\s+run\s+(\S+)/);
  if (npmRunMatch) return `npm: ${npmRunMatch[1]}`;

  // npm start / npm test / npm install
  const npmDirectMatch = cmd.match(/^npm\s+(start|test|install|ci|audit)\b/);
  if (npmDirectMatch) return `npm: ${npmDirectMatch[1]}`;

  // yarn dev / pnpm dev
  const yarnPnpmMatch = cmd.match(/^(yarn|pnpm)\s+(\S+)/);
  if (yarnPnpmMatch) return `${yarnPnpmMatch[1]}: ${yarnPnpmMatch[2]}`;

  // nodemon <script>
  if (/^nodemon\b/.test(cmd)) {
    const target = cmd.match(/^nodemon\s+(?:--\S+\s+)*(\S+)/);
    if (target) return `Nodemon: ${basename(target[1])}`;
    return 'Nodemon';
  }

  // vite / next dev / next start
  if (/^(?:npx\s+)?vite\b/.test(cmd)) return 'Vite';
  if (/^(?:npx\s+)?next\s+dev\b/.test(cmd)) return 'Next.js Dev';
  if (/^(?:npx\s+)?next\s+start\b/.test(cmd)) return 'Next.js';

  // node <script>
  //   `node /path/to/vite.js` 这种 (pnpm/npm scripts 实际 exec 的形式) 拿到 basename
  //   后, 优先映射到知名工具的语义名 — 比泛泛 "Node: vite" 更准, 跟用户对该服务的
  //   心智 ("我跑的是 Vite") 对齐. 不在字典里的还是 "Node: <script>" 兜底.
  const nodeMatch = cmd.match(/^node\s+(?:--\S+\s+)*(\S+)/);
  if (nodeMatch) {
    const scriptName = basename(nodeMatch[1]).replace(/\.[mc]?[jt]sx?$/, '');
    const knownTool = KNOWN_NODE_TOOLS[scriptName.toLowerCase()];
    if (knownTool) return knownTool;
    return `Node: ${scriptName}`;
  }

  /* ===== Python 生态 ===== */

  // python -m <module> [port]
  const pyModMatch = cmd.match(/^python3?\s+-m\s+(\S+)(?:\s+(\d+))?/);
  if (pyModMatch) {
    const mod = pyModMatch[1];
    const port = pyModMatch[2];
    if (mod === 'http.server') return port ? `HTTP Server :${port}` : 'HTTP Server';
    if (mod === 'flask') return 'Flask';
    if (mod === 'uvicorn') return 'Uvicorn';
    if (mod === 'gunicorn') return 'Gunicorn';
    return `Python: ${mod}`;
  }
  // python xxx.py
  const pyScriptMatch = cmd.match(/^python3?\s+(?:-\S+\s+)*(\S+\.py)\b/);
  if (pyScriptMatch) return `Python: ${basename(pyScriptMatch[1]).replace(/\.py$/, '')}`;

  // flask run / django runserver
  if (/^flask\s+run\b/.test(cmd)) return 'Flask';
  if (/^django(?:-admin)?\s+runserver\b/.test(cmd)) return 'Django';

  /* ===== 容器 / 编排 ===== */

  if (/^docker\s+compose\b/.test(cmd)) return 'Docker Compose';
  if (/^docker-compose\b/.test(cmd)) return 'Docker Compose';
  if (/^docker\s+run\b/.test(cmd)) {
    /* image 名提取 — docker run 的 flag 可能带值 (-p HOST:CTR, -v VOL, -e KEY=VAL),
     * 单纯 (?:-\S+\s+)* 会把 -p 吃掉但 5432:5432 又被当成 image. 简化: image 名一般是
     * 最后一个 token 或紧邻 image 名前没有 - 起的值. 用更严格的 image 名 pattern
     * (字母/数字/. _-/ + tag/digest 字符, 排除端口绑定 N:N). */
    const tokens = cmd.split(/\s+/).slice(2); /* drop "docker run" */
    let image: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith('-')) {
        /* 跳过 flag, 跳过它的值 (除非是 = 形式) */
        if (!t.includes('=') && i + 1 < tokens.length) i++;
        continue;
      }
      /* 排除端口绑定值 / volume 路径值 */
      if (/^\d+:\d+$/.test(t)) continue;
      if (t.startsWith('/') || t.startsWith('./')) continue;
      /* image 候选: 字母数字 + ./_-:/ 字符, 不含 = */
      if (/^[a-zA-Z][a-zA-Z0-9._\-/]*(:[\w.-]+)?$/.test(t)) {
        image = t;
        break;
      }
    }
    return image ? `Docker: ${image}` : 'Docker';
  }
  if (/^kubectl\s+/.test(cmd)) return 'kubectl';

  /* ===== Rust / Go / Ruby / 其它 ===== */

  if (/^cargo\s+run\b/.test(cmd)) return 'Cargo Run';
  if (/^cargo\s+(\S+)/.test(cmd)) {
    const m = cmd.match(/^cargo\s+(\S+)/);
    return `Cargo: ${m![1]}`;
  }
  if (/^go\s+run\b/.test(cmd)) return 'Go Run';
  if (/^rails\s+s(?:erver)?\b/.test(cmd)) return 'Rails Server';
  if (/^bundle\s+exec\s+rails\s+s/.test(cmd)) return 'Rails Server';

  /* ===== Watchers / Tail ===== */

  if (/^tail\s+-[fF]\s+(\S+)/.test(cmd)) {
    const m = cmd.match(/^tail\s+-[fF]\s+(\S+)/);
    return `Tail: ${basename(m![1])}`;
  }

  /* ===== Free shell ===== */

  if (/^exec\s+\S*\/(z|ba|fi)?sh(\s+-i)?$/.test(cmd)) return 'Shell';

  return undefined;
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p;
}

/** `node <script>` 时, script basename 命中这张表 → 直接用工具语义名, 不显示 "Node: ..." 前缀.
 *  覆盖 pnpm/npm run dev 实际 exec 出的常见前端工具二进制 — Vite / Next / Webpack / Turbo / Nx 等. */
const KNOWN_NODE_TOOLS: Record<string, string> = {
  vite: 'Vite',
  next: 'Next.js',
  webpack: 'Webpack',
  'webpack-dev-server': 'Webpack',
  rollup: 'Rollup',
  esbuild: 'esbuild',
  turbo: 'Turbo',
  nx: 'Nx',
  tsx: 'tsx',
  parcel: 'Parcel',
  rspack: 'Rspack',
  rsbuild: 'Rsbuild',
  remix: 'Remix',
  astro: 'Astro',
  nuxt: 'Nuxt',
  gatsby: 'Gatsby',
  storybook: 'Storybook',
  jest: 'Jest',
  vitest: 'Vitest',
};
