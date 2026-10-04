/**
 * Shell command parser implemented as a lightweight state machine. It keeps
 * quoted arguments intact, splits chains and substitutions, evaluates segments,
 * and derives command timeout hints.
 */

// ===================== 解析结果类型 =====================

export interface ParsedCommand {
  /** 原始命令文本 */
  raw: string;
  /** 基础命令（第一个 token） */
  base: string;
  /** 参数 tokens */
  args: string[];
  /** 命令连接符（前驱）：';' | '&&' | '||' | '|' | null（首个命令） */
  connector: string | null;
  /** 是否包含子命令展开 $() 或 `` */
  hasSubstitution: boolean;
  /** 是否有输入/输出重定向 */
  hasRedirect: boolean;
  /** 重定向目标文件（如果有） */
  redirectTarget?: string;
}

export interface ShellParseResult {
  /** 拆分后的命令段 */
  commands: ParsedCommand[];
  /** 原始完整命令 */
  original: string;
  /** 是否包含管道链 */
  hasPipeline: boolean;
  /** 是否包含子命令展开 */
  hasSubstitution: boolean;
  /** 推断的超时（毫秒） */
  inferredTimeoutMs: number;
}

// ===================== 超时推断表 =====================

/**
 * Command-specific timeout hints avoid treating every command as a single
 * global timeout class.
 */
const COMMAND_TIMEOUT_MAP: Record<string, number> = {
  // 快速命令 (10s)
  ls: 10_000,
  pwd: 10_000,
  echo: 10_000,
  cat: 10_000,
  head: 10_000,
  tail: 10_000,
  wc: 10_000,
  which: 10_000,
  whoami: 10_000,
  date: 10_000,
  hostname: 10_000,
  uname: 10_000,
  basename: 10_000,
  dirname: 10_000,
  realpath: 10_000,
  readlink: 10_000,

  // 文件操作 (30s)
  cp: 30_000,
  mv: 30_000,
  rm: 30_000,
  mkdir: 30_000,
  touch: 30_000,
  chmod: 30_000,
  chown: 30_000,
  ln: 30_000,

  // 搜索 (60s)
  find: 60_000,
  grep: 60_000,
  rg: 60_000,
  ag: 60_000,
  fd: 60_000,
  locate: 60_000,
  sed: 60_000,
  awk: 60_000,
  sort: 60_000,
  uniq: 60_000,
  diff: 60_000,
  xargs: 60_000,

  // Git (60s)
  git: 60_000,

  // 包管理 (300s = 5min)
  npm: 300_000,
  yarn: 300_000,
  pnpm: 300_000,
  pip: 300_000,
  pip3: 300_000,
  poetry: 300_000,
  cargo: 300_000,
  go: 300_000,
  composer: 300_000,
  bundle: 300_000,
  gem: 300_000,
  brew: 300_000,
  apt: 300_000,
  'apt-get': 300_000,  // quoted: hyphenated key

  // 构建 (300s)
  make: 300_000,
  cmake: 300_000,
  tsc: 300_000,
  webpack: 300_000,
  esbuild: 60_000,
  vite: 300_000,
  rollup: 300_000,
  gcc: 300_000,
  'g++': 300_000,
  javac: 300_000,
  rustc: 300_000,

  // 测试 (300s)
  jest: 300_000,
  mocha: 300_000,
  pytest: 300_000,
  vitest: 300_000,
  playwright: 300_000,
  cypress: 300_000,

  // Docker (600s = 10min)
  docker: 600_000,
  'docker-compose': 600_000,
  podman: 600_000,

  // 网络 (60s)
  curl: 60_000,
  wget: 60_000,
  ssh: 120_000,
  scp: 300_000,
  rsync: 300_000,

  // 数据库 (120s)
  psql: 120_000,
  mysql: 120_000,
  sqlite3: 120_000,
  mongosh: 120_000,
  'redis-cli': 120_000,

  // 编辑器/交互 (不适合 agent)
  vim: 10_000,
  nano: 10_000,
  less: 10_000,
  more: 10_000,

  // ==================== Windows / PowerShell ====================
  // PowerShell cmdlets（cmdlet 名是 Verb-Noun 格式）
  'Get-Content': 10_000,
  'Set-Content': 30_000,
  'Get-ChildItem': 10_000,
  'Get-Item': 10_000,
  'Get-Location': 10_000,
  'Set-Location': 10_000,
  'New-Item': 30_000,
  'Remove-Item': 30_000,
  'Copy-Item': 30_000,
  'Move-Item': 30_000,
  'Select-String': 60_000,
  'Where-Object': 60_000,
  'ForEach-Object': 60_000,
  'Invoke-WebRequest': 60_000,
  'Invoke-RestMethod': 60_000,
  'Start-Process': 30_000,
  'Stop-Process': 10_000,
  'Get-Process': 10_000,
  'Test-Path': 10_000,
  'Out-File': 30_000,
  'Write-Output': 10_000,
  'Write-Host': 10_000,

  // Windows cmd 内置命令
  dir: 10_000,
  type: 10_000,
  copy: 30_000,
  move: 30_000,
  del: 30_000,
  rd: 30_000,
  md: 30_000,
  ren: 30_000,
  attrib: 10_000,
  tasklist: 10_000,
  taskkill: 10_000,
  where: 10_000,
  icacls: 30_000,
  netstat: 10_000,
  ipconfig: 10_000,
  systeminfo: 30_000,
  wmic: 30_000,
  reg: 30_000,
  sc: 30_000,
  net: 30_000,
  certutil: 60_000,
  choco: 300_000,
  winget: 300_000,
  scoop: 300_000,
  dotnet: 300_000,
  msbuild: 300_000,
  nuget: 300_000,
};

const DEFAULT_TIMEOUT_MS = 120_000;

// ===================== 状态机解析器 =====================

/** 引号感知的 token 拆分 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingle) {
      escaped = true;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble && (ch === ' ' || ch === '\t')) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/** 检测子命令展开 */
function detectSubstitution(input: string): boolean {
  let inSingle = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && !inSingle) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (!inSingle) {
      // $(...) 形式
      if (ch === '$' && i + 1 < input.length && input[i + 1] === '(') {
        return true;
      }
      // `...` 反引号形式
      if (ch === '`') {
        return true;
      }
    }
    i++;
  }
  return false;
}

/** 检测重定向并提取目标 */
function detectRedirect(tokens: string[]): { hasRedirect: boolean; target?: string } {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // >file, >>file, 2>file, 2>&1, &>file
    if (/^[0-9]*>{1,2}/.test(t) || /^&>/.test(t)) {
      // 重定向符后面可能直接跟文件名或者是下一个 token
      const afterOp = t.replace(/^[0-9]*>{1,2}|^&>/, '');
      if (afterOp) {
        return { hasRedirect: true, target: afterOp };
      }
      if (i + 1 < tokens.length) {
        return { hasRedirect: true, target: tokens[i + 1] };
      }
      return { hasRedirect: true };
    }
    // <file 输入重定向
    if (t.startsWith('<') && t.length > 1) {
      return { hasRedirect: true, target: t.slice(1) };
    }
    if (t === '<' && i + 1 < tokens.length) {
      return { hasRedirect: true, target: tokens[i + 1] };
    }
  }
  return { hasRedirect: false };
}

/**
 * 引号感知的命令链拆分
 *
 * 将 "cmd1 && cmd2 | cmd3 ; cmd4 || cmd5" 拆成 5 个段
 * 但不会拆 "echo 'a && b'" 里引号内的 &&
 */
function splitCommandChain(input: string): Array<{ raw: string; connector: string | null }> {
  const segments: Array<{ raw: string; connector: string | null }> = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0;
  let currentConnector: string | null = null;
  let i = 0;

  const flush = (nextConnector: string) => {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push({ raw: trimmed, connector: currentConnector });
    }
    current = '';
    currentConnector = nextConnector;
  };

  while (i < input.length) {
    const ch = input[i];

    // 转义
    if (ch === '\\' && !inSingle) {
      current += ch;
      if (i + 1 < input.length) {
        current += input[i + 1];
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // 引号
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    // 在引号内不拆
    if (inSingle || inDouble) {
      current += ch;
      i++;
      continue;
    }

    // 括号嵌套
    if (ch === '(' || (ch === '$' && i + 1 < input.length && input[i + 1] === '(')) {
      parenDepth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--;
      current += ch;
      i++;
      continue;
    }

    // 在括号内不拆
    if (parenDepth > 0) {
      current += ch;
      i++;
      continue;
    }

    // && 连接符
    if (ch === '&' && i + 1 < input.length && input[i + 1] === '&') {
      flush('&&');
      i += 2;
      continue;
    }

    // || 连接符
    if (ch === '|' && i + 1 < input.length && input[i + 1] === '|') {
      flush('||');
      i += 2;
      continue;
    }

    // | 管道
    if (ch === '|') {
      flush('|');
      i++;
      continue;
    }

    // 分号
    if (ch === ';') {
      flush(';');
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // 最后一段
  const trimmed = current.trim();
  if (trimmed) {
    segments.push({ raw: trimmed, connector: currentConnector });
  }

  return segments;
}

/** 去掉引号壳（用于提取 base 命令） */
function unquote(token: string): string {
  if ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))) {
    return token.slice(1, -1);
  }
  return token;
}

// ===================== 公共 API =====================

/**
 * 解析 shell 命令为结构化结果
 *
 * 支持：
 * - 引号感知（不被内部 && ; | 误拆）
 * - 命令链拆分（;, &&, ||, |）
 * - 子命令展开检测
 * - 重定向检测
 * - 动态超时推断
 */
export function parseShellCommand(command: string): ShellParseResult {
  const segments = splitCommandChain(command);
  const commands: ParsedCommand[] = [];
  let hasPipeline = false;
  let hasSubstitution = false;
  let maxTimeout = 0;

  for (const seg of segments) {
    const tokens = tokenize(seg.raw);
    const base = tokens.length > 0 ? unquote(tokens[0]) : '';
    const args = tokens.slice(1);
    const segHasSub = detectSubstitution(seg.raw);
    const redirect = detectRedirect(tokens);

    if (seg.connector === '|') {
      hasPipeline = true;
    }
    if (segHasSub) {
      hasSubstitution = true;
    }

    // 计算这一段的超时 — 取所有段的最大值
    const baseCmd = base.includes('/') ? base.split('/').pop()! : base;
    const cmdTimeout = COMMAND_TIMEOUT_MAP[baseCmd] ?? DEFAULT_TIMEOUT_MS;
    if (cmdTimeout > maxTimeout) {
      maxTimeout = cmdTimeout;
    }

    commands.push({
      raw: seg.raw,
      base,
      args,
      connector: seg.connector,
      hasSubstitution: segHasSub,
      hasRedirect: redirect.hasRedirect,
      redirectTarget: redirect.target,
    });
  }

  return {
    commands,
    original: command,
    hasPipeline,
    hasSubstitution,
    inferredTimeoutMs: maxTimeout || DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Return a command timeout hint in milliseconds. Pipelines and command chains
 * use the maximum hint among their segments.
 */
export function inferCommandTimeout(command: string): number {
  const result = parseShellCommand(command);
  return result.inferredTimeoutMs;
}

/**
 * 导出超时映射表（供测试和外部使用）
 */
export { COMMAND_TIMEOUT_MAP, DEFAULT_TIMEOUT_MS };
