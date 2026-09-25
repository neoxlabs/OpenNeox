
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { evaluateToolRisk, isHighRiskLevel } from '@neoxlabs/kernel/core/toolRiskEvaluator.js';

/* ── Life 附加严格层 (kernel 规则之外, 生活场景专属) ──
 * kernel 只把 `rm -rf /` 级别列 critical; 生活助理连 `rm 单个文件`/`mv`/
 * `defaults write` 都不该自主做 — 每段命令的首 token 命中即拦。 */
const LIFE_STRICT_HEAD = new RegExp(
  '^(?:' + [
    'rm', 'rmdir', 'shred', 'srm', 'dd',
    'mv',
    'sudo', 'su', 'doas',
    'kill',
    'exec', 'eval',
    'osascript',           /* 系统级 AppleScript 万能口 — macOS 桥工具是受控替代 */
    'defaults', 'crontab', 'launchctl', 'systemctl', 'service',
    'diskutil', 'nvram', 'csrutil', 'spctl', 'tmutil',
    'chmod', 'chown', 'chflags', 'chgrp',
    'ssh', 'scp', 'sftp', 'rsync',
  ].join('|') + ')\\b',
);

/* 重定向写文件 — write_file 工具是受控替代; `>/dev/null` 与 `2>&1` 放行 */
const REDIRECT_WRITE = /(^|[^>])>{1,2}\s*(?!\s*(?:\/dev\/null|&\d))\S/;

/** 按 shell 连接符拆段 (粗粒度, 宁可误拦不可漏放 — `ls && rm -rf ~` 混不过) */
function splitSegments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\n|\|/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 危险判定: 返回 null = 放行; 返回字符串 = 拦截原因 */
export function dangerousShellReason(command: string): string | null {
  const cmd = (command || '').trim();
  if (!cmd) return null;
  /* 主判定: kernel 风险引擎 (与 Code 审批链同一真源) — high/critical 即拦 */
  try {
    const assessment = evaluateToolRisk({ toolName: 'execute_shell', args: { command: cmd } });
    const hit = assessment.signals.find(s => isHighRiskLevel(s.level));
    if (hit) return hit.message;
  } catch { /* 评估器异常 — 落到 Life 附加层, 不放飞 */ }
  /* Life 附加严格层 */
  if (REDIRECT_WRITE.test(cmd)) return '重定向写文件';
  for (const seg of splitSegments(cmd)) {
    const stripped = seg.replace(/^(?:\w+=\S*\s+)+/, '');   /* 跳过 FOO=bar 前缀 */
    if (LIFE_STRICT_HEAD.test(stripped)) {
      return `危险命令: ${stripped.split(/\s+/)[0]}`;
    }
  }
  return null;
}

export function wrapShellForGuardedMode(tool: Tool, _mode: 'work'): Tool {
  const label = '工作模式';
  const recovery = '工作模式不提供绕过口 —— 这类操作请改用受控工具 (write_file / rename_file / delete_file), '
    + '或让用户切到编码模式自行执行。不要换个写法绕过。';
  const boundary = `[${label}] 用于跑数据处理脚本与只读命令。删除、移动、系统设置、提权、外发 (ssh/scp)、重定向写文件会被拦截。写文件请用 write_file。`;

  return {
    ...tool,
    description: `${tool.description}\n\n${boundary}`,
    function: async (args, context) => {
      const cmd = String((args as { command?: string })?.command ?? '');
      const reason = dangerousShellReason(cmd);
      if (reason) {
        return JSON.stringify({
          success: false,
          blocked: true,
          error: `${label}已拦截 (${reason})。这条命令有破坏性/系统级影响, ${label}只放行只读与无害命令。${recovery}`,
        });
      }
      return tool.function(args, context);
    },
  };
}
