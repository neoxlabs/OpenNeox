/**
 * 外部 Agent 契约 —— 插件清单里 `externalAgents` 字段
 *
 *   目的: 让 Neox 把活派给用户机器上**已经装好**的另一个 agent CLI
 *   (Codex / Claude Code / Aider / …), 结果回到同一条 timeline。
 *
 *   用户已经付了三份订阅, 却只能一次用一个 —— 这个扩展点解决的是这件事。
 *
 *   为什么是声明式而不是让插件自己 spawn
 *   ------------------------------------
 *   插件的 `tools` 扩展点是 JS 模块, 加载后**全宿主权限、零沙箱** —— 一个
 *   「接 Codex」的插件和一个「偷 SSH key」的插件在那条路径上没有任何区别。
 *
 *   而且自己 spawn 的进程是孤儿: 输出接不进 timeline、用户中断杀不掉、
 *   切 workspace 收不回、跟主 agent 抢同一个工作区互相覆盖。
 *
 *   所以插件交的是**一张命令行映射表**, 进程由宿主起 —— 隔离、流式、中断、
 *   超时全归宿主。第三方要接一个新 agent 也就不需要交可执行代码。
 *
 *   这仍然是 T2 档 (跑在用户本机)
 *   ----------------------------
 *   它终究是在用户机器上执行程序, 所以安装时必须显式征得同意, 并且:
 *     · command 只能是**裸二进制名**, 走 PATH 解析 —— 用的是用户自己装的那个,
 *       插件不能自带二进制, 也不能指向插件目录里的文件
 *     · 禁止通用解释器 (sh/bash/python/node/…) —— 那会把「跑 codex」变成
 *       「跑任意东西」, 整个声明式的意义就没了
 *     · spawn 不过 shell, 参数逐个传 argv —— prompt 里有什么字符都不会被解释
 */

export type LocalizedText = { en: string; zh?: string };

/**
 * 输出流的解析方式。
 *
 *   两家的 headless 输出格式都在动 (codex exec 的尤其不稳定), 所以解析器一律
 *   **容错**: 认不出的行原样当文本, 而不是报错中断 —— 派出去的活跑了二十分钟
 *   因为一行没认出来就全废, 是不能接受的。
 */
export type ExternalAgentStreamFormat =
  /** NDJSON, Claude Code `--output-format stream-json` */
  | 'claude-stream-json'
  /** NDJSON, Codex `exec --json` */
  | 'codex-json'
  /** 纯文本 */
  | 'text';

/**
 * 工作区隔离方式。
 *
 *   **刻意不做成工具参数** —— 让模型自己选要不要隔离, 等于没有隔离。
 *   这是清单说了算、用户装的时候看得见的东西。
 */
export type ExternalAgentIsolation =
  /** 各跑各的 git worktree, 结束后看 diff 决定合不合 (默认) */
  | 'worktree'
  /** 直接在当前工作区跑 —— 会跟主 agent 抢同一批文件, 只给明确知道自己在干嘛的场景 */
  | 'workspace';

export type ExternalAgentDetect = {
  /** 探测用的参数, 通常是 ['--version'] */
  args: string[];
  /** 没装时告诉用户怎么装 */
  installHint: LocalizedText;
};

export type PluginExternalAgentDefinition = {
  /** 稳定 id, 小写字母数字下划线。工具名由它派生: `<id>_delegate` */
  id: string;
  displayName: LocalizedText;
  description: LocalizedText;

  /**
   * 可执行文件名。**只能是裸名**, 不允许路径分隔符 —— 见文件头。
   */
  command: string;

  /** 探测装没装 */
  detect: ExternalAgentDetect;

  /**
   * 参数模板。支持三个占位符, 各自只能整串出现, 不做字符串拼接:
   *   {{prompt}} —— 派下去的任务描述
   *   {{model}} —— 调用方指定的模型 (没给就整条参数丢掉)
   *   {{workdir}} —— 实际工作目录 (隔离时是 worktree 路径)
   */
  argsTemplate: string[];

  streamFormat: ExternalAgentStreamFormat;
  isolation?: ExternalAgentIsolation;

  /** 单次任务上限, 缺省 30 分钟 */
  timeoutMs?: number;


  /** 装完之后给用户看的示例用法 —— 装了不知道怎么用是插件市场的头号死因 */
  examplePrompts?: string[];
};

export const EXTERNAL_AGENT_ID_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

/** 默认单次上限: 派一个真任务出去动辄十几分钟, 30 分钟是个不至于误杀的线 */
export const EXTERNAL_AGENT_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 通用解释器黑名单。
 *
 *   命中即拒。理由不是「这些程序危险」, 而是**它们让声明式失去意义**:
 *   `sh -c "任意东西"` 和「声明要跑哪个 agent」不是一回事, 后者能被用户看懂
 *   并据此决定装不装, 前者不能。
 */
export const EXTERNAL_AGENT_FORBIDDEN_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh',
  'python', 'python2', 'python3', 'node', 'deno', 'bun',
  'ruby', 'perl', 'php', 'lua', 'osascript',
  'env', 'eval', 'exec', 'xargs', 'sudo', 'doas', 'ssh',
]);

/** 只允许这三个占位符 —— 不给清单触达进程环境之类东西的口子 */
export const EXTERNAL_AGENT_PLACEHOLDERS = ['prompt', 'model', 'workdir'] as const;
export type ExternalAgentPlaceholder = (typeof EXTERNAL_AGENT_PLACEHOLDERS)[number];
