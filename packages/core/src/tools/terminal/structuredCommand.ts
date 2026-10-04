import { createSummarizedResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { getShellEnv } from '@neoxlabs/platform/platform/shellEnv.js';
import { COMMAND_PRESETS, buildCommandForPreset, detectCommandPreset, normalizeCommandPreset, type CommandPreset } from './commandPresets.js';
import { getShellOutputStreamCallback } from '../shell/shellUiCallbacks.js';
import { writeStallFile } from '@neoxlabs/kernel/utils/stallGuard.js';

function emitTerminalOutputToUi(
  toolCallId: string | undefined,
  command: string,
  combined: string,
  exitCode: number,
  durationMs: number,
): void {
  writeStallFile('info', 'RUN_CMD', 'structured command output → UI', {
    command, toolCallId, outputLen: combined.length, exitCode, emit: !!toolCallId && !!combined,
    hasCallback: !!getShellOutputStreamCallback(),
  });
  if (!toolCallId || !combined) return;
  try {
    getShellOutputStreamCallback()?.({
      toolId: toolCallId,
      command,
      output: combined,
      outputDelta: combined,
      elapsed: durationMs,
      isComplete: true,
      exitCode,
    });
  } catch { /* UI 推流失败绝不影响工具结果 */ }
}

type StructuredCommandKind = 'test' | 'lint' | 'format';

export type StructuredCommandArgs = {
  /** 模型传来的原始值 —— 经 normalizeCommandPreset 收敛后才是 CommandPreset */
  preset?: CommandPreset | string;
  command?: string;
  extra_args?: string[];
  cwd?: string;
  timeout_ms?: number;
};

type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<RunCommandResult>;

function parseSimpleCommand(command: string): { command: string; args: string[] } {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] || '', args: parts.slice(1) };
}

const ALLOWED_COMMANDS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'npx',
  'pytest', 'ruff', 'black', 'go', 'cargo', 'make',
  'mvn', 'maven', 'mvnw',
  'gradle', 'gradlew',
  'flutter', 'dart',
]);

/** Win 上用户会写成 mvn.cmd / flutter.bat / .\\gradlew.bat, 跟 Unix 裸命令是同一个工具。 */
function allowedCommandName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() || raw;
  return base.replace(/\.(cmd|bat|exe|ps1)$/i, '').toLowerCase();
}

function outputTail(combined: string, maxLines = 15, maxChars = 1500): string {
  const lines = combined.split('\n').filter(l => l.trim());
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}

function spawnFailure(combined: string, exitCode: number): boolean {
  return exitCode === -1 && /\[spawn error\]|\[error\]|ENOENT|not recognized as (?:an|the name of a)/i.test(combined);
}

/** 缺 runner 时的统一回执 —— 说清缺谁、当时用的什么 PATH、以及怎么绕开。 */
function missingRunnerResult(toolName: string, binary: string, cwd: string, combined: string): string {
  const path = getShellEnv().PATH ?? '<unset>';
  return JSON.stringify(createSummarizedResult(
    toolName,
    'error',
    `\`${binary}\` is not installed (or not on PATH) — nothing was run.`,
    {
      error: `${binary} not found on PATH`,
      precondition: true,
      metadata: {
        missing_binary: binary,
        cwd,
        path_used: path.length > 400 ? `${path.slice(0, 400)}…` : path,
        spawn_error: combined.trim().slice(0, 300),
        hint: `Install ${binary}, or pass command="<runner you do have>" (allowed: ${Array.from(ALLOWED_COMMANDS).join(', ')}).`,
      },
    },
  ));
}

export async function runStructuredCommandFromRuntimeTools(params: {
  toolName: string;
  kind: StructuredCommandKind;
  args: StructuredCommandArgs;
  resolveWorkspacePath: (requestedPath?: string) => string;
  runCommand: RunCommand;
  truncateText: (text: string, maxChars: number) => { text: string; truncated: boolean };
  maxCommandOutputChars: number;
  maxErrorSnippetChars: number;
  toolCallId?: string;
}): Promise<string> {
  const cwd = params.resolveWorkspacePath(params.args.cwd || '.');

  if (params.args.extra_args !== undefined && !Array.isArray(params.args.extra_args)) {
    return JSON.stringify(createSummarizedResult(
      params.toolName,
      'error',
      'Invalid extra_args: expected an array of strings',
      { error: 'extra_args must be an array' }
    ));
  }

  const extraArgs = Array.isArray(params.args.extra_args)
    ? params.args.extra_args.map(value => String(value))
    : [];

  const command = params.args.command;
  const rawPreset = params.args.preset;
  const preset = rawPreset ? normalizeCommandPreset(rawPreset) : await detectCommandPreset(cwd);
  if (rawPreset && !preset && !command) {
    /* 参数闸: 模型写了个不认识的 preset。告诉它合法值, 它下一轮自己改 —— 不是故障, 不弹红卡。 */
    return JSON.stringify(createSummarizedResult(
      params.toolName,
      'error',
      `Unknown preset "${String(rawPreset)}" — use one of: ${COMMAND_PRESETS.join(', ')} (python projects: preset="pytest"), or pass command="…" explicitly`,
      { error: 'unknown_preset', guidance: true, metadata: { preset: String(rawPreset), allowed: [...COMMAND_PRESETS] } }
    ));
  }

  if (command) {
    const parsed = parseSimpleCommand(command);
    if (!parsed.command) {
      return JSON.stringify(createSummarizedResult(
        params.toolName,
        'error',
        'Invalid command',
        { error: 'Command is empty' }
      ));
    }

    if (!ALLOWED_COMMANDS.has(allowedCommandName(parsed.command))) {
      return JSON.stringify(createSummarizedResult(
        params.toolName,
        'error',
        'Command not allowed',
        { error: `Allowed commands: ${Array.from(ALLOWED_COMMANDS).join(', ')}` }
      ));
    }

    const finalArgs = parsed.args.concat(extraArgs);
    const result = await params.runCommand(parsed.command, finalArgs, cwd, { timeoutMs: params.args.timeout_ms || 300000 });
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
    emitTerminalOutputToUi(params.toolCallId, [parsed.command, ...finalArgs].join(' '), combined, result.exitCode, result.durationMs);
    if (spawnFailure(combined, result.exitCode)) {
      return missingRunnerResult(params.toolName, parsed.command, cwd, combined);
    }
    const snippet = params.truncateText(combined, params.maxCommandOutputChars);
    const summary = result.exitCode === 0
      ? `${params.toolName} succeeded (${result.durationMs}ms)`
      : `${params.toolName} failed with exit code ${result.exitCode}`;

    return JSON.stringify(createSummarizedResult(
      params.toolName,
      result.exitCode === 0 ? 'success' : 'error',
      summary,
      {
        error: result.exitCode === 0 ? undefined : params.truncateText(combined, params.maxErrorSnippetChars).text,
        metadata: {
          command: [parsed.command, ...finalArgs].join(' '),
          exit_code: result.exitCode,
          duration_ms: result.durationMs,
          output_truncated: snippet.truncated,
          ...(result.exitCode === 0 ? { output_tail: outputTail(combined) } : {}),
        },
      }
    ));
  }

  if (preset) {
    const built = buildCommandForPreset(preset, params.kind, extraArgs, cwd);
    const result = await params.runCommand(built.command, built.args, cwd, { timeoutMs: params.args.timeout_ms || 300000 });
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
    emitTerminalOutputToUi(params.toolCallId, [built.command, ...built.args].join(' '), combined, result.exitCode, result.durationMs);
    if (spawnFailure(combined, result.exitCode)) {
      return missingRunnerResult(params.toolName, built.command, cwd, combined);
    }
    const snippet = params.truncateText(combined, params.maxCommandOutputChars);

    /* "Missing script" 不是工具坏 — 项目没定义 lint/format/test 这一项 script,
       这是 80% 的 Node 工程的常态。npm/pnpm/yarn/bun 都会刷一大坨 "npm error npm error"
       让用户看着像炸了,实际只是没那个脚本。识别一下,翻译成一句人话, 当 success 返回。
       规则:exit code != 0 + 输出含 "Missing script: \"<kind>\"" 或 "no script named". */
    if (result.exitCode !== 0 && (preset === 'npm' || preset === 'pnpm' || preset === 'yarn' || preset === 'bun')) {
      const missingScript =
        /missing script:\s*"?([\w-]+)"?/i.exec(combined)?.[1] ||
        /no script named\s+"?([\w-]+)"?/i.exec(combined)?.[1] ||
        /command\s+"?([\w-]+)"?\s+not found/i.exec(combined)?.[1];
      if (missingScript && missingScript === params.kind) {
        return JSON.stringify(createSummarizedResult(
          params.toolName,
          'success',
          `${params.toolName}: no "${params.kind}" script defined in ${preset} package.json — nothing to run.`,
          {
            metadata: {
              command: [built.command, ...built.args].join(' '),
              exit_code: result.exitCode,
              duration_ms: result.durationMs,
              skipped: true,
              skip_reason: 'missing_script',
              hint: `Define a "${params.kind}" script in package.json (e.g., "${params.kind}": "<linter/formatter command>"), or pass command="<your-tool>" explicitly.`,
            },
          }
        ));
      }
    }

    const summary = result.exitCode === 0
      ? `${params.toolName} succeeded (${result.durationMs}ms)`
      : `${params.toolName} failed with exit code ${result.exitCode}`;

    return JSON.stringify(createSummarizedResult(
      params.toolName,
      result.exitCode === 0 ? 'success' : 'error',
      summary,
      {
        error: result.exitCode === 0 ? undefined : params.truncateText(combined, params.maxErrorSnippetChars).text,
        metadata: {
          command: [built.command, ...built.args].join(' '),
          exit_code: result.exitCode,
          duration_ms: result.durationMs,
          output_truncated: snippet.truncated,
          ...(result.exitCode === 0 ? { output_tail: outputTail(combined) } : {}),
        },
      }
    ));
  }

  /* 没探测到 preset 不是错误 — 当前 cwd 没有 package.json/Cargo.toml/Makefile 等
     标识文件,工具没法自动选命令。把它当 "无操作" 而非错误返回,模型据此决定下一步:
     要么用 command 显式传命令,要么换 cwd,要么放弃跑测试。*/
  const summary = [
    `${params.toolName}: no project type detected at ${cwd}.`,
    `Looked for: pom.xml, pubspec.yaml, build.gradle, package.json, pnpm-lock.yaml, yarn.lock, bun.lockb, pyproject.toml, pytest.ini, go.mod, Cargo.toml, Makefile.`,
    `To proceed, either:`,
    `  - pass command="npm test" / "pytest tests/" / "go test ./..." etc. (allowed: ${Array.from(ALLOWED_COMMANDS).join(', ')})`,
    `  - pass preset=<name> with the runner you want`,
    `  - pass cwd=<path-with-build-files> to point at the right subproject`,
  ].join('\n');

  return JSON.stringify(createSummarizedResult(
    params.toolName,
    'success',
    summary,
    {
      metadata: {
        cwd,
        kind: params.kind,
        detected_preset: null,
      },
    }
  ));
}
