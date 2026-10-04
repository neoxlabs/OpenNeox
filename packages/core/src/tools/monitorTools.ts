
import { watch } from 'fs';
import { execa } from 'execa';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolCategory, ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { getToolServices } from './runtimeToolServices.js';
import { buildShellInvocation } from './shell/shellInvocation.js';
import { resolveWorkspacePath } from './workspace/pathHelpers.js';
import { getCurrentChatSessionId } from '../runtime/shell/chatSessionContext.js';
import { getBackgroundTaskNotifier } from '../runtime/shell/backgroundTaskNotifier.js';
import { desktopWatcherStore } from '../runtime/shell/watcherStore.js';
import {
  getMonitorRegistry,
  setMonitorDepsFactory,
  describeTrigger,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MAX_FIRES,
  MIN_POLL_SECONDS,
  MAX_POLL_SECONDS,
  type MonitorDeps,
  type MonitorInfo,
  type MonitorRegistry,
  type MonitorTrigger,
} from '../runtime/shell/monitorRegistry.js';

const POLL_COMMAND_TIMEOUT_MS = 60_000;
const POLL_OUTPUT_MAX = 64 * 1024;

function realDeps(): MonitorDeps {
  const pm = getToolServices().processManager;
  return {
    onProcessOutput(cb) {
      pm.on('process:output', cb);
      return () => { pm.off('process:output', cb); };
    },
    onProcessEnd(cb) {
      const onEnd = (proc: { pid: number }) => cb(proc.pid);
      pm.on('process:exit', onEnd);
      pm.on('process:kill', onEnd);
      return () => { pm.off('process:exit', onEnd); pm.off('process:kill', onEnd); };
    },
    isProcessRunning(pid) {
      return pm.get(pid)?.status === 'running';
    },
    async runCommand(command, cwd) {
      const inv = buildShellInvocation(command, true);
      const r = await execa(inv.cmd, inv.args, {
        cwd,
        env: getToolServices().shellEnv.getShellEnv(),
        reject: false,
        all: true,
        timeout: POLL_COMMAND_TIMEOUT_MS,
        maxBuffer: POLL_OUTPUT_MAX,
        ...(inv.windowsVerbatimArgs ? { windowsVerbatimArguments: true } : {}),
      });
      return { exitCode: typeof r.exitCode === 'number' ? r.exitCode : -1, output: String(r.all ?? '') };
    },
    watchPath(path, onChange) {
      /* recursive: macOS / Windows 原生支持, Linux 从 Node 20 起支持 */
      const w = watch(path, { recursive: true, persistent: false }, (_e, file) => onChange(file ? String(file) : null));
      w.on('error', () => { /* 目录被删等 —— 盯不了就不盯了, 到期照常收尾 */ });
      return { close: () => w.close() };
    },
    store: desktopWatcherStore<MonitorInfo>('monitors'),
  };
}

/* 加载即登记: runtime 启动时 (runtimeBridgeSetup) 就能建出 registry 并从磁盘恢复, 不必等第一次用工具 */
setMonitorDepsFactory(realDeps);

function registry(): MonitorRegistry {
  return getMonitorRegistry()!;
}

function currentSessionId(): string | undefined {
  return getCurrentChatSessionId() ?? getBackgroundTaskNotifier().getCurrentSessionId();
}

function noSession(): string {
  return JSON.stringify({
    status: 'success',
    skipped: true,
    reason: 'no_active_session',
    message: 'Monitors need an active chat session to wake up; this runtime has none (headless/test). Check inline instead.',
  });
}

function started(r: ReturnType<MonitorRegistry['start']>): string {
  if ('error' in r) return JSON.stringify({ status: 'error', error: r.error });
  const { info } = r;
  const watching = describeTrigger(info.trigger);
  return JSON.stringify({
    monitor_id: info.id,
    watching,
    max_fires: info.maxFires,
    expires_at_iso: new Date(info.expiresAt).toISOString(),
    /* 界面 (CLI) 只拿得到 message 这一句 —— 以固定的 "Watching: … · id …" 开头, 卡片据此显示盯什么 */
    message: `Watching: ${watching} · id ${info.id}. When it fires, your next turn starts with <monitor-event>…</monitor-event> — do not sleep or poll for it. Continue with other work or hand control back to the user.`,
  });
}

const COMMON_PROPS = {
  label: { type: 'string', description: 'One line: what you are watching for (shown to the user in the notification and the monitor list).' },
  prompt: { type: 'string', description: 'What to do when it fires, e.g. "read bash_output(pid=123) around the error and fix it".' },
  maxFires: { type: 'number', description: `How many times it may fire before stopping (default 1, max ${MAX_FIRES}).` },
  timeoutSeconds: { type: 'number', description: `Stop after this long (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}). If it never fired you are woken once to be told so.` },
} as const;

export const monitorStartTool: Tool = {
  name: 'monitor_start',
  aliases: ['monitor', 'watch'],
  description: `Wake yourself when something happens, instead of sleeping or polling. Two triggers here (for a command that must be re-run, use monitor_poll):

- type="output": watch a RUNNING background process (from execute_shell background=true) and fire when a line of its output matches \`pattern\` (JavaScript regex, case-insensitive). Matches within 2s are merged into one event. Examples: dev server prints "error|failed", "listening on|ready in", a test watcher prints "FAIL".
- type="file": fire when files change under \`path\` (recursive; node_modules/.git ignored; changes within 1.5s merged).

When it fires, your next turn starts with <monitor-event> containing the matched lines / changed files and your prompt. The user also gets a system notification. A monitor fires at most once a minute (every fire costs a full turn); anything in between is carried into the next event, so keep maxFires small. Process exit is reported separately as <background-task-notification>, so an output monitor simply ends when its process exits.

Use it when the user wants to be told about something later ("tell me if the server errors", "let me know when the build output says done"). Do not use it for things you can check right now.`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['output', 'file'] },
      pid: { type: 'number', description: 'type=output: pid of the running background process.' },
      pattern: { type: 'string', description: 'type=output: regex matched against each output line (case-insensitive).' },
      path: { type: 'string', description: 'type=file: file or directory to watch (relative to the workspace root is fine).' },
      ...COMMON_PROPS,
    },
    required: ['type', 'label', 'prompt'],
  },
  async function(args: any): Promise<string> {
    const sessionId = currentSessionId();
    if (!sessionId) return noSession();
    let trigger: MonitorTrigger;
    if (args?.type === 'output') trigger = { type: 'output', pid: Number(args.pid), pattern: String(args.pattern ?? '') };
    else if (args?.type === 'file') {
      const raw = String(args.path ?? '').trim();
      trigger = { type: 'file', path: raw ? resolveWorkspacePath(raw) : '' };
    } else return JSON.stringify({ status: 'error', error: 'type must be "output" or "file" (use monitor_poll to re-run a command).' });
    return started(registry().start({
      sessionId, label: args.label, prompt: args.prompt, trigger,
      maxFires: args.maxFires, timeoutSeconds: args.timeoutSeconds,
    }));
  },
};

export const monitorPollTool: Tool = {
  name: 'monitor_poll',
  description: `Re-run a check command every N seconds and wake yourself when its condition becomes true — for waiting on things outside this machine or without a process to watch: CI status, a deploy, an endpoint coming up, a queue draining.

- until="success" (default): fires when the command exits 0 (e.g. \`curl -sf http://localhost:3000/health\`, \`gh run view 123 --json conclusion -q '.conclusion == "success"'\` with a test).
- until="match": fires when the output matches \`pattern\` (regex, case-insensitive).
- until="change": fires when the output differs from the first run (e.g. \`gh pr view 42 --json reviews\`).

It fires when the condition turns true (not on every poll while it stays true), and at most once a minute. Keep the command a quick read-only check; it runs with the same approval rules as execute_shell. Interval ${MIN_POLL_SECONDS}-${MAX_POLL_SECONDS}s (default 60), each run times out after 60s. The first check runs immediately.`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  permission: {
    category: ToolCategory.EXECUTE,
    defaultPermission: ToolPermission.ASK,
    permissionReason: 'Runs this command repeatedly until the condition is met',
  },
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The check command (runs in the workspace root).' },
      intervalSeconds: { type: 'number', description: `Seconds between runs (${MIN_POLL_SECONDS}-${MAX_POLL_SECONDS}, default 60).` },
      until: { type: 'string', enum: ['success', 'match', 'change'] },
      pattern: { type: 'string', description: 'until=match: regex matched against the output.' },
      ...COMMON_PROPS,
    },
    required: ['command', 'label', 'prompt'],
  },
  async function(args: any): Promise<string> {
    const sessionId = currentSessionId();
    if (!sessionId) return noSession();
    const until = args?.until === 'match' || args?.until === 'change' ? args.until : 'success';
    return started(registry().start({
      sessionId, label: args.label, prompt: args.prompt,
      trigger: {
        type: 'poll', command: String(args?.command ?? ''), until,
        intervalSeconds: args?.intervalSeconds ?? 60, pattern: args?.pattern,
      },
      maxFires: args.maxFires, timeoutSeconds: args.timeoutSeconds,
      cwd: getWorkspaceRootFromContext() || undefined,
    }));
  },
};

export const monitorListTool: Tool = {
  name: 'monitor_list',
  description: 'List the monitors running in this session (what each watches, fires used, when it expires).',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,
  parameters: { type: 'object', properties: {} },
  async function(): Promise<string> {
    const sessionId = currentSessionId();
    if (!sessionId) return noSession();
    const list = getMonitorRegistry()?.listForSession(sessionId) ?? [];
    return JSON.stringify({
      monitors: list.map((m) => ({
        monitor_id: m.id, label: m.label, watching: describeTrigger(m.trigger),
        fires: `${m.fires}/${m.maxFires}`, expires_at_iso: new Date(m.expiresAt).toISOString(),
      })),
    });
  },
};

export const monitorStopTool: Tool = {
  name: 'monitor_stop',
  description: 'Stop a monitor by monitor_id (from monitor_start / monitor_poll / monitor_list).',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,
  parameters: {
    type: 'object',
    properties: { monitor_id: { type: 'string' } },
    required: ['monitor_id'],
  },
  async function(args: any): Promise<string> {
    const sessionId = currentSessionId();
    const id = String(args?.monitor_id ?? '');
    const reg = getMonitorRegistry();
    /* 只许停自己会话的 —— 别的会话的监控不归这一轮管 */
    const mine = sessionId ? reg?.listForSession(sessionId).some((m) => m.id === id) : false;
    if (!mine) return JSON.stringify({ status: 'error', error: `No monitor ${id} in this session (see monitor_list).` });
    reg!.stop(id);
    return JSON.stringify({ status: 'success', stopped: id });
  },
};

export const MONITOR_TOOLS: Tool[] = [monitorStartTool, monitorPollTool, monitorListTool, monitorStopTool];
