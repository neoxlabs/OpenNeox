/**
 * 敏感路径识别 —— 给审批风险评估用 (toolRiskEvaluator 把命中的路径记成 critical)。
 *
 * 历史 (SEC1  / SEC2): 这套判断原来在 neox-core/tools/workspace/pathHelpers.ts,
 * 由每个文件/git 工具在**执行时硬拒绝** ("Path is outside workspace，已拒绝")。
 *  挪到这里并改成走审批 (需求： "要么申请权限 要么就给权限"):
 *   · 硬拒绝不看审批档 —— dangerous 档也拒, 需求说明"改我的 ~/.aws/config"也拒, 只能绕去 shell
 *     (shell 能写任何地方, 所以这层硬墙挡住的只有用户自己);
 *   · 错误文案还写着 "outside workspace", 实际原因是命中了敏感名单, 模型和用户都看不懂;
 *   · 名单里整个 `~/.neox` 都算敏感 —— 创建技能要写 ~/.neox/skills/<id>/SKILL.md, 直接被拒。
 * 现在: 命中 → critical 信号 → auto / manual 档弹审批问用户, dangerous 档放行 (用户的知情选择)。
 *
 * 名单分两类:
 *   凭据/密钥存储 —— 读出来就是外泄 (.ssh / .aws / Keychains ...)
 *   写进去等于任意命令执行 —— 不含秘密, 但写一行下次就执行 (.git/hooks、.git/config、hook 配置、LaunchAgents ...)
 *
 * 匹配按路径 segment (不是字符串前缀), 防 `/home/user/.sshx` 混淆 `.ssh`;
 * 大小写不敏感 (macOS/Windows 文件系统默认大小写不敏感, `.SSH` 同样命中)。
 */
import os from 'node:os';
import path from 'node:path';

const SENSITIVE_HOME_DIRS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker',
  '.config/gcloud', '.config/gh',
  '.password-store', '.gpg', 'Library/Keychains',
  'Library/LaunchAgents', 'Library/LaunchDaemons',
];
const SENSITIVE_HOME_FILES = [
  '.netrc', '.pgpass', '.git-credentials',
];
/** 任意目录下命中即算敏感的文件名 (凭据/密钥)。Neox 自己的凭据文件 (auth.enc 等) 在这里按文件名收, 不再整目录收 ~/.neox。 */
const SENSITIVE_BASENAMES = new Set([
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'auth.enc', 'gateway-key.enc', 'routing.json', 'anon.key',
  '.git-credentials', 'credentials',
]);
/** 任意目录下命中即算敏感的 segment (整段相等才算)。 */
const SENSITIVE_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.password-store']);

/**
 * 「写进去等于拿到任意命令执行」的配置位置。
 *   .neox/settings.json · settings.local.json   hook 配置, 写一条 PreToolUse command 下个工具调用就在跑它
 *   .neox/hooks/                                同上, 脚本形态
 *   .neox/mcp.json                              一条 stdio server 就是一条任意命令
 *   .neox/config.json                           provider / 网关地址, 改了能把所有请求带去别处
 *   .git/hooks/ · .git/config · .git/info/attributes   git 一动就执行 / url.insteadOf 改推送目标
 * 只收这几个具体位置, 不收整个 .git / .neox: 那里有知识卡、技能、plans、git 对象这些正当读写的东西。
 */
function isCodeExecConfigPath(lowerSegs: string[]): boolean {
  for (let i = 0; i < lowerSegs.length; i++) {
    const rest = lowerSegs.slice(i + 1);
    if (lowerSegs[i] === '.git') {
      if (rest[0] === 'hooks') return true;
      if (rest.length === 1 && rest[0] === 'config') return true;
      if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'attributes') return true;
      /* 子模块自己的 .git/modules/<name>/{config,hooks} 是同一件事 */
      if (rest[0] === 'modules' && (rest.includes('hooks') || rest[rest.length - 1] === 'config')) return true;
    }
    if (lowerSegs[i] === '.neox') {
      if (rest.length === 1 && ['settings.json', 'settings.local.json', 'mcp.json', 'config.json'].includes(rest[0]!)) return true;
      if (rest[0] === 'hooks') return true;
    }
  }
  return false;
}

function toSegments(absPath: string): string[] {
  return path.resolve(absPath).split(/[\\/]+/).filter(Boolean);
}

function segmentsStartWith(segs: string[], prefix: string[]): boolean {
  if (prefix.length > segs.length) return false;
  return prefix.every((p, i) => segs[i]!.toLowerCase() === p.toLowerCase());
}

/** 命中凭据存储 / 可执行配置 / 系统持久化位置 → true。参数须是绝对路径。 */
export function isSensitivePath(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  const segs = toSegments(resolved);
  const lowerSegs = segs.map((s) => s.toLowerCase());
  const base = path.basename(resolved);

  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (lowerSegs.some((s) => SENSITIVE_SEGMENTS.has(s))) return true;
  if (isCodeExecConfigPath(lowerSegs)) return true;

  const homeSegs = toSegments(os.homedir());
  if (segmentsStartWith(segs, homeSegs)) {
    const rel = segs.slice(homeSegs.length);
    const relLower = rel.map((s) => s.toLowerCase()).join('/');
    for (const dir of SENSITIVE_HOME_DIRS) {
      const dl = dir.toLowerCase();
      if (relLower === dl || relLower.startsWith(dl + '/')) return true;
    }
    if (rel.length === 1 && SENSITIVE_HOME_FILES.some((f) => f.toLowerCase() === relLower)) return true;
  }

  /* 系统级持久化 / 密钥位置 */
  if (lowerSegs[0] === 'etc') return true;
  if (lowerSegs[0] === 'private' && lowerSegs[1] === 'etc') return true;

  return false;
}
