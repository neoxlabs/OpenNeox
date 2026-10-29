
export interface AgentTerminalRequest {
  requestId: string;
  command: string;
  cwd: string;
  timeout?: number;
}

export interface AgentTerminalResult {
  output: string;
  exitCode: number;
  error?: string;
}

export type AgentTerminalRunner = (req: AgentTerminalRequest) => Promise<AgentTerminalResult>;

let runner: AgentTerminalRunner | null = null;

/** TerminalManager 挂载时注册自己; 卸载时传 null。 */
export function registerAgentTerminalRunner(fn: AgentTerminalRunner | null): void {
  runner = fn;
  if (import.meta.env?.DEV) {
    (window as unknown as { __neoxAgentTerminal?: AgentTerminalRunner | null }).__neoxAgentTerminal = fn;
  }
}

export function hasAgentTerminalRunner(): boolean {
  return runner !== null;
}

/** 没有已挂载的终端就返回 null —— 调用方据此退回弹层, **不能**让 agent 卡在这儿等。 */
export function runInAgentTerminal(req: AgentTerminalRequest): Promise<AgentTerminalResult> | null {
  if (!runner) return null;
  return runner(req);
}

/** 一次执行的完成标记。requestId 进标记里 —— 同一个 tab 里连着跑两条命令时,
 *  前一条的残留输出不会被后一条认成自己的结束。 */
export function doneMarker(requestId: string): string {
  return `__NEOX_DONE_${requestId}__`;
}

/** 包成一行送进 shell (**兜底模式**, 见 buildPromptHook)。
 *  · `\n` 开头: 保证标记独占一行, 不会粘在上一条命令的输出尾巴上;
 *  · 用 `;` 而不是 `&&`: 命令失败时标记**也要**打印, 否则失败的命令永远等不到结束。 */
export function wrapCommand(command: string, requestId: string): string {
  return `${command}\nprintf '\\n${doneMarker(requestId)}%s\\n' "$?"\n`;
}

const ESC = '\u001b';
const BEL = '\u0007';
export const OSC_DONE_PREFIX = `${ESC}]633;NeoxDone;`;

export function buildPromptHook(): string {
  return `__neox_done() { printf '\\033]633;NeoxDone;%s\\007' "$?"; }; precmd() { __neox_done; }; PROMPT_COMMAND=__neox_done\n`;
}

/** 从输出里认 OSC 标记 —— 干净模式下的完成判定。返回 null = 还没跑完。
 *  取**最后**一个: 同一个 tab 里连着跑时, 前一条的标记不能算这一条的结束。 */
export function matchOscDone(output: string): { exitCode: number } | null {
  const i = output.lastIndexOf(OSC_DONE_PREFIX);
  if (i < 0) return null;
  const rest = output.slice(i + OSC_DONE_PREFIX.length);
  /* BEL 收尾才算一个完整的序列 —— 只收到半截 (数据分片) 时不能判成跑完 */
  const m = rest.match(new RegExp(`^(\\d*)${BEL}`));
  if (!m) return null;
  return { exitCode: m[1] ? Number(m[1]) : 0 };
}

/** OSC 标记是控制序列, 终端不画它, 但 agent 读的是纯文本 —— 摘掉。 */
export function stripOsc(output: string): string {
  return output.split(new RegExp(`${ESC}\\]633;NeoxDone;\\d*${BEL}`)).join('');
}

/** 从累积输出里找完成标记。返回 null = 还没跑完。 */
export function matchDone(output: string, requestId: string): { exitCode: number } | null {
  const marker = doneMarker(requestId);
  /* 只认**回显之后**的那一次 —— shell 会把我们写进去的那行命令原样回显一遍,
   * 那一次里 %s 还没被替换, 后面不跟数字。所以要求标记后面紧跟数字。 */
  const re = new RegExp(`${marker}(\\d+)`);
  const m = output.match(re);
  if (m) return { exitCode: Number(m[1]) };
  /* fish/nu 这类不认 `$?` 的 shell: 标记会打印但后面没有数字 (或是空)。
   * 命令确实结束了, 只是拿不到退出码 —— 当 0, 不猜。
   * 判据要求标记后面跟着换行, 免得把回显那一次算进来。 */
  if (new RegExp(`${marker}\\s*\\n`).test(output)) return { exitCode: 0 };
  return null;
}

/** 把 sentinel 那两行从给 agent 的输出里摘掉 —— 它是我们加的脚手架, 不是命令的输出。 */
export function stripMarker(output: string, requestId: string): string {
  const marker = doneMarker(requestId);
  return output
    .split('\n')
    .filter((line) => !line.includes(marker) && !line.includes("printf '\\n__NEOX_DONE_"))
    .join('\n');
}
