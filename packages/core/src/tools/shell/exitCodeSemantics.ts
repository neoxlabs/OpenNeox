/**
 * Command Exit Code Semantics — 把命令退出码翻译成语义标签
 *
 * 目的: LLM 看到 grep 退出 1 不要慌, 看到 pytest 退出 1 不要假装没事.
 *       不同命令的退出码语义差异巨大, 用 boolean success 一刀切会误导.
 *
 * 用法:
 *   const result = evaluateExitCode('grep -n foo file.ts', 1);
 *   // → { semantics: 'no_match', success: true, hint: 'grep 退出 1 表示没匹配, 不是错误' }
 *
 * 工具结果里加 semantics + success 字段, prompt 已告诉 LLM 优先看这两个.
 */

export interface ExitCodeSemantic {
  /** 语义标签, 给 LLM 看 */
  semantics: string;
  /** 任务是否真正成功(命令本身工作正常 + 任务目标达成) */
  success: boolean;
  /** 给 LLM 的简短解释, 只在容易误判的退出码上有 */
  hint?: string;
}

/**
 * 命令头 → 退出码 → 语义
 *
 * 设计原则:
 *   - exitCode 0 总是 success(除非命令本身设计反了, 暂未发现)
 *   - 非 0 才需要查表; 表里没有的退出码默认 success=false
 *   - "no_match"/"has_diff" 这种是命令工作正常的非匹配信号 → success=true
 *   - "test_failed"/"compile_error" 是真失败 → success=false
 */
type CmdMap = Record<number, ExitCodeSemantic>;

const TABLE: Record<string, CmdMap> = {
  // ─── 搜索类 — 1 通常是 no_match, 不是错误 ───
  grep: {
    0: { semantics: 'match_found', success: true },
    1: { semantics: 'no_match', success: true, hint: 'grep 退出 1 表示没找到匹配, 不是错误' },
    2: { semantics: 'grep_error', success: false, hint: '正则错误或文件读不了' },
  },
  egrep: {
    0: { semantics: 'match_found', success: true },
    1: { semantics: 'no_match', success: true, hint: 'egrep 退出 1 表示没找到匹配' },
    2: { semantics: 'grep_error', success: false },
  },
  fgrep: {
    0: { semantics: 'match_found', success: true },
    1: { semantics: 'no_match', success: true, hint: 'fgrep 退出 1 表示没找到匹配' },
    2: { semantics: 'grep_error', success: false },
  },
  rg: {
    0: { semantics: 'match_found', success: true },
    1: { semantics: 'no_match', success: true, hint: 'rg(ripgrep) 退出 1 表示没匹配, 不是错误' },
    2: { semantics: 'rg_error', success: false },
  },
  ag: {
    0: { semantics: 'match_found', success: true },
    1: { semantics: 'no_match', success: true, hint: 'ag(silver searcher) 退出 1 表示没匹配' },
  },

  // ─── 比较类 — 1 通常是 has_diff, 不是错误 ───
  diff: {
    0: { semantics: 'identical', success: true },
    1: { semantics: 'has_diff', success: true, hint: 'diff 退出 1 表示有差异, 这是 diff 在工作, 不是错误' },
    2: { semantics: 'diff_error', success: false, hint: '文件读不了或参数错' },
  },
  cmp: {
    0: { semantics: 'identical', success: true },
    1: { semantics: 'has_diff', success: true, hint: 'cmp 退出 1 表示有差异' },
    2: { semantics: 'cmp_error', success: false },
  },

  // ─── 测试类 — 1 是真失败 ───
  pytest: {
    0: { semantics: 'tests_passed', success: true },
    1: { semantics: 'tests_failed', success: false, hint: 'pytest 退出 1: 至少一个测试失败' },
    2: { semantics: 'pytest_usage_error', success: false },
    3: { semantics: 'pytest_internal_error', success: false },
    4: { semantics: 'pytest_usage_error', success: false },
    5: { semantics: 'no_tests_collected', success: false, hint: 'pytest 退出 5: 没收集到任何测试' },
  },
  jest: {
    0: { semantics: 'tests_passed', success: true },
    1: { semantics: 'tests_failed', success: false, hint: 'jest 退出 1: 至少一个测试失败' },
  },
  vitest: {
    0: { semantics: 'tests_passed', success: true },
    1: { semantics: 'tests_failed', success: false, hint: 'vitest 退出 1: 至少一个测试失败' },
  },
  mocha: {
    0: { semantics: 'tests_passed', success: true },
    // mocha 失败数 = 退出码(>=1 都是失败)
  },

  // ─── 编译/类型检查 ───
  tsc: {
    0: { semantics: 'typecheck_ok', success: true },
    1: { semantics: 'tsc_argument_error', success: false },
    2: { semantics: 'type_errors', success: false, hint: 'tsc 退出 2: 有类型错误' },
    3: { semantics: 'type_errors', success: false },
  },
  'go': {
    // go 是分子命令, 实际语义看子命令(go vet / go build / go test). 这里给个保底
    0: { semantics: 'ok', success: true },
    1: { semantics: 'go_error', success: false },
    2: { semantics: 'go_error', success: false },
  },
  cargo: {
    // cargo check / cargo build / cargo test 都用 cargo 头. 保底语义.
    0: { semantics: 'cargo_ok', success: true },
    101: { semantics: 'cargo_error', success: false, hint: 'cargo 退出 101: 编译错误或 panic' },
  },

  // ─── 包管理 / 构建 ───
  npm: {
    0: { semantics: 'npm_ok', success: true },
    // npm 退出码非 0 全是失败, 不用列
  },
  yarn: {
    0: { semantics: 'yarn_ok', success: true },
  },
  pnpm: {
    0: { semantics: 'pnpm_ok', success: true },
  },
  bun: {
    0: { semantics: 'bun_ok', success: true },
  },

  // ─── 其它常见 ───
  test: {
    // POSIX `[` / test
    0: { semantics: 'test_true', success: true },
    1: { semantics: 'test_false', success: true, hint: 'POSIX test/[ 退出 1 = 条件为假, 不是错误' },
    2: { semantics: 'test_syntax_error', success: false },
  },
  curl: {
    0: { semantics: 'curl_ok', success: true },
    // curl 错误码很多 (1-94), 不一一列, 默认走 default
  },
  ssh: {
    0: { semantics: 'ssh_ok', success: true },
    255: { semantics: 'ssh_connect_failed', success: false, hint: 'ssh 退出 255: 连接失败' },
  },
};

/**
 * 解析命令头 — 拨开 sudo / env VAR=val / nice / time 等前缀, 也拨开 pipe / && 之后的部分.
 *
 * 例:
 *   "sudo -E rg foo /etc"         → "rg"
 *   "FOO=1 BAR=2 pytest -k bug"   → "pytest"
 *   "grep -r foo . | head"        → "grep"  (取第一个真实命令)
 *   "cargo check 2>&1"            → "cargo"
 *   "npx tsc --noEmit"            → "tsc"   (npx 后第一个非选项 token)
 *   "/usr/bin/grep foo bar"       → "grep"  (basename)
 */
export function parseCommandHead(command: string): string | null {
  if (!command) return null;

  // 取第一段(在 |, &&, ||, ;, > 等结构控制符之前的部分)
  const firstSegment = command.split(/\s*(?:\|\||&&|;|\||>|<)\s*/)[0]?.trim();
  if (!firstSegment) return null;

  // 拆 token, 跳过 sudo / env / nice / time / VAR=val 等前缀
  const tokens = firstSegment.split(/\s+/).filter(Boolean);
  const SKIP_PREFIX = new Set([
    'sudo', 'env', 'nice', 'time', 'nohup', 'exec',
    'npx', 'pnpx', 'bunx', 'yarn', // 包运行器: 把 yarn xxx 视作 xxx (但 yarn 本身退出码也有意义, 见下)
  ]);

  let head: string | null = null;
  let yarnSeenWithoutSubcmd = true; // 跟踪 yarn 是否裸跑

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // VAR=value 形式的环境变量赋值, 跳过
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    // sudo 自带选项 -E / -u user, 跳过这些选项
    if (tok.startsWith('-')) continue;

    // 跳过 wrapper 前缀
    if (SKIP_PREFIX.has(tok)) {
      // yarn/pnpm/npm + run/test 这种, 退出码语义跟着 yarn 走更准确(不是子命令)
      // 但 npx tsc 这种 wrapper 是透明的, 应该解析到 tsc
      if (tok === 'npx' || tok === 'pnpx' || tok === 'bunx') continue;
      // yarn / pnpm 的语义是它们自己的(npm 同), 直接返回
      if (tok === 'yarn' || tok === 'pnpm') {
        // 但如果是 `yarn run test`, jest/vitest 会被 wrap, 这里只能用 yarn 的退出码
        head = tok;
        break;
      }
      continue;
    }

    head = tok;
    break;
  }

  if (!head) return null;

  // 取 basename (去掉路径 + .exe 之类)
  const slash = head.lastIndexOf('/');
  if (slash >= 0) head = head.slice(slash + 1);
  const bs = head.lastIndexOf('\\');
  if (bs >= 0) head = head.slice(bs + 1);
  if (head.endsWith('.exe')) head = head.slice(0, -4);

  return head || null;
}

/**
 * 评估命令的退出码语义.
 *
 * 返回 null 表示这个命令没有特殊语义(走默认: 0=success, 非0=failure).
 * 调用方应当用 null 兜底逻辑.
 */
export function evaluateExitCode(
  command: string,
  exitCode: number | null | undefined,
): ExitCodeSemantic | null {
  if (exitCode === null || exitCode === undefined) return null;

  const head = parseCommandHead(command);
  if (!head) return null;

  const cmdMap = TABLE[head];
  if (!cmdMap) return null;

  const entry = cmdMap[exitCode];
  if (entry) return entry;

  // 命令在表里但这个 exit code 没列 — 0 默认 success, 非 0 默认 failure
  return {
    semantics: exitCode === 0 ? `${head}_ok` : `${head}_error_${exitCode}`,
    success: exitCode === 0,
  };
}

/**
 * 给 shell tool 用的便捷封装: 返回最终的 success + 可选 semantics + 可选 hint.
 * 如果命令没特殊语义, fallback 到 exitCode === 0.
 */
export function classifyShellResult(
  command: string,
  exitCode: number | null | undefined,
): { success: boolean; semantics?: string; semanticsHint?: string } {
  const semantic = evaluateExitCode(command, exitCode);
  if (semantic) {
    return {
      success: semantic.success,
      semantics: semantic.semantics,
      semanticsHint: semantic.hint,
    };
  }
  return {
    success: exitCode === 0,
  };
}
