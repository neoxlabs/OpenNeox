/**
 * `externalAgents` 声明的校验
 *
 *   这个扩展点会在用户机器上执行程序, 所以校验挡的不是「字段填没填」, 而是
 *   四条会让「声明式」这三个字失去意义的形态:
 *
 *     1. command 带路径     → 插件可以指向自带的二进制, 等于夹带可执行代码
 *     2. command 是解释器   → `sh -c "任意东西"`, 用户看清单也看不出会跑什么
 *     3. 占位符不整串出现   → `--flag={{prompt}}` 这类拼接会让注入面重新出现
 *     4. 缺 {{prompt}}      → 派不出去任务的 agent 声明是死的
 *
 *   前两条挡不住就没必要做这一层 —— 直接让插件写 tools 模块 spawn 反而更诚实。
 */

import {
  EXTERNAL_AGENT_CREDENTIALS,
  EXTERNAL_AGENT_FORBIDDEN_COMMANDS,
  EXTERNAL_AGENT_ID_PATTERN,
  EXTERNAL_AGENT_PLACEHOLDERS,
} from '@neoxlabs/platform/shared/plugin-external-agent.js';

const STREAM_FORMATS = new Set([
  'claude-stream-json', 'codex-json', 'droid-stream-json', 'opencode-json', 'kimi-stream-json', 'cline-json', 'text',
]);
const ISOLATIONS = new Set(['worktree', 'workspace']);
const WHOLE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/;

function isLocalized(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  if (typeof t.en !== 'string' || !t.en.trim()) return false;
  if (t.zh !== undefined && typeof t.zh !== 'string') return false;
  return true;
}

export function validateExternalAgents(raw: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(raw)) {
    return { errors: ['externalAgents must be an array'], warnings };
  }

  const seenIds = new Set<string>();

  raw.forEach((a: any, i: number) => {
    const at = `externalAgents[${i}]`;
    const bad = (field: string, message: string) => errors.push(`${at}.${field}: ${message}`);

    if (!a || typeof a !== 'object') {
      errors.push(`${at}: must be an object`);
      return;
    }

    // ── 身份 ────────────────────────────────────────────────────────────
    if (typeof a.id !== 'string' || !EXTERNAL_AGENT_ID_PATTERN.test(a.id)) {
      bad('id', 'must be lowercase letters/digits/underscore, 2-31 chars (the tool name derives from it)');
    } else if (seenIds.has(a.id)) {
      bad('id', `duplicate external agent id "${a.id}"`);
    } else {
      seenIds.add(a.id);
    }

    if (!isLocalized(a.displayName)) bad('displayName', 'must be { en, zh? }');
    if (!isLocalized(a.description)) {
      bad('description', 'must be { en, zh? } — the model reads this to decide when to delegate');
    }

    // ── command: 裸名 + 非解释器 ─────────────────────────────────────────
    if (typeof a.command !== 'string' || !a.command.trim()) {
      bad('command', 'is required');
    } else {
      const cmd = a.command.trim();
      if (cmd.includes('/') || cmd.includes('\\')) {
        bad(
          'command',
          'must be a bare executable name resolved on PATH — a path lets the plugin ship its own binary',
        );
      }
      if (/[\s;&|<>$`"'*?()\[\]{}]/.test(cmd)) {
        bad('command', 'must not contain whitespace or shell metacharacters');
      }
      if (EXTERNAL_AGENT_FORBIDDEN_COMMANDS.has(cmd.toLowerCase())) {
        bad(
          'command',
          `"${cmd}" is a general-purpose interpreter — declaring it would turn this into arbitrary execution, which the declarative form exists to avoid`,
        );
      }
    }

    // ── detect ──────────────────────────────────────────────────────────
    if (!a.detect || typeof a.detect !== 'object') {
      bad('detect', 'is required — the host must be able to tell whether the CLI is installed');
    } else {
      if (!Array.isArray(a.detect.args) || a.detect.args.some((x: unknown) => typeof x !== 'string')) {
        bad('detect.args', 'must be an array of strings (usually ["--version"])');
      }
      if (!isLocalized(a.detect.installHint)) {
        bad('detect.installHint', 'must be { en, zh? } — told to the user when the CLI is missing');
      }
    }

    // ── argsTemplate ────────────────────────────────────────────────────
    if (!Array.isArray(a.argsTemplate) || a.argsTemplate.length === 0) {
      bad('argsTemplate', 'must declare at least one argument');
    } else {
      let sawPrompt = false;
      a.argsTemplate.forEach((arg: unknown, j: number) => {
        if (typeof arg !== 'string') {
          bad(`argsTemplate[${j}]`, 'must be a string');
          return;
        }
        if (!arg.includes('{{')) return;

        const whole = WHOLE_PLACEHOLDER.exec(arg);
        if (!whole) {
          /* `--prompt={{prompt}}` 这类拼接会把用户输入混进一个参数里。
           * 整串占位符则是一个独立 argv 元素, 内容再离谱也只是内容。 */
          bad(
            `argsTemplate[${j}]`,
            'a placeholder must be the entire argument (e.g. "{{prompt}}"), not concatenated into one',
          );
          return;
        }
        const name = whole[1];
        if (!(EXTERNAL_AGENT_PLACEHOLDERS as readonly string[]).includes(name)) {
          bad(
            `argsTemplate[${j}]`,
            `unknown placeholder "{{${name}}}" — only ${EXTERNAL_AGENT_PLACEHOLDERS.join(' / ')} are available`,
          );
        }
        if (name === 'prompt') sawPrompt = true;
      });

      if (!sawPrompt) {
        bad('argsTemplate', 'must contain {{prompt}} — otherwise no task can be delegated');
      }
    }

    // ── 其余 ────────────────────────────────────────────────────────────
    if (!STREAM_FORMATS.has(a.streamFormat)) {
      bad('streamFormat', `must be one of: ${[...STREAM_FORMATS].join(', ')}`);
    }
    if (a.isolation !== undefined && !ISOLATIONS.has(a.isolation)) {
      bad('isolation', `must be one of: ${[...ISOLATIONS].join(', ')}`);
    }
    if (a.isolation === 'workspace') {
      /* 不拦, 但要说出口: 它会跟主 agent 抢同一批文件 */
      warnings.push(
        `externalAgents[${i}] ("${a.id}") runs directly in the workspace — it can overwrite files the main agent is editing`,
      );
    }
    if (a.timeoutMs !== undefined && (typeof a.timeoutMs !== 'number' || a.timeoutMs <= 0)) {
      bad('timeoutMs', 'must be a positive number of milliseconds');
    }
    if (a.examplePrompts !== undefined) {
      if (!Array.isArray(a.examplePrompts) || a.examplePrompts.some((x: unknown) => typeof x !== 'string')) {
        bad('examplePrompts', 'must be an array of strings');
      }
    }
    if (a.runtime !== undefined) {
      if (!a.runtime || typeof a.runtime !== 'object' || (a.runtime.node !== undefined && !/^\d+(\.\d+){0,2}$/.test(String(a.runtime.node)))) {
        bad('runtime', 'must be { node?: "22.19" } — a minimum Node.js version');
      }
    }
    if (a.credentials !== undefined) {
      if (!Array.isArray(a.credentials) || a.credentials.some((c: unknown) => typeof c !== 'string' || !(c in EXTERNAL_AGENT_CREDENTIALS))) {
        bad('credentials', `must be an array of: ${Object.keys(EXTERNAL_AGENT_CREDENTIALS).join(', ')}`);
      }
    }
    if (a.defaultModelFrom !== undefined) {
      const d = a.defaultModelFrom;
      const fileOk = d && typeof d.file === 'string' && /^~\/[^\0]+$/.test(d.file) && !d.file.split('/').includes('..');
      const pathsOk = d && Array.isArray(d.paths) && d.paths.length > 0 && d.paths.every((p: unknown) => typeof p === 'string' && /^[\w.-]+$/.test(p));
      if (!fileOk || !pathsOk || (d.match !== undefined && typeof d.match !== 'string')) {
        bad('defaultModelFrom', 'must be { file: "~/…", paths: ["a.b.0.c"], match?: "regex" } — file under home, no ".."');
      }
    }
    if (a.endpointFrom !== undefined) {
      const d = a.endpointFrom;
      const fileOk = d && typeof d.file === 'string' && /^~\/[^\0]+$/.test(d.file) && !d.file.split('/').includes('..');
      if (!fileOk || typeof d.path !== 'string' || !/^[\w.{}-]+$/.test(d.path)) {
        bad('endpointFrom', 'must be { file: "~/…", path: "a.{key}.b" } — file under home, no ".."');
      }
    }
  });

  return { errors, warnings };
}
