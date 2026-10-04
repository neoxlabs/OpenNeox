/**
 * AgentTypes - 内置 Agent 类型定义
 *
 * 每种 agent 有独立的：
 * - 工具白名单（能力边界）
 * - 系统提示（行为约束）
 * - 默认配置（温度、迭代上限等）
 *
 * 设计原则：工具越少越聚焦，LLM 表现越好。
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { BROWSER_PACK_TOOL_NAMES } from '../browser/browserToolDefs.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentTypeDefinition {
  /** 类型标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 简短描述（给主 agent 看，用于选型） */
  description: string;
  /** 什么时候该选它 —— 自定义 agent 的 whenToUse, 内置的靠 description 就够 */
  whenToUse?: string;
  /** 这个角色钉死的模型别名。空 = 跟随全局的子 Agent 路由 / 继承主模型。
   *  「审计用重模型、跑测试用轻模型」就靠这一个字段 —— 见 agentTool 的模型优先级。 */
  model?: string;
  /** 来源: 内置 / 用户目录 / 工作区 / 插件。UI 和错误文案要能说清这个 agent 从哪来。 */
  source?: 'builtin' | 'user' | 'workspace' | 'plugin';
  /** 允许的工具名集合，'*' 表示全量 */
  allowedTools: Set<string> | '*';
  /** 排除的工具名（在 allowedTools='*' 时生效） */
  excludedTools: Set<string>;
  /** 系统提示构建器 */
  buildSystemPrompt: (workDir: string, parentContext: string, description: string, task: string) => string;
  /** agent 运行配置 */
  config: {
    temperature: number;
    maxIterations: number;
    maxRuntimeMs: number;
  };
  /** 内部类型: 只给工具内部派发用 (如 deep_research 的调研员), 不出现在 agent 工具的 type 枚举里 */
  internal?: boolean;
}

// ============================================================================
// 工具集定义
// ============================================================================

const ALWAYS_EXCLUDED = new Set([
  'agent', 'explore', 'select_tools', 'call_tool', 'use_skill',
  'ask_user',
  /* 停谁由派它们的主 agent 决定, 子 agent 不许互相叫停 */
  'stop_agent',
  'team_run',
  'activate_target', 'plan_target', 'check_target_done',
  'abandon_target', 'pause_target', 'continue_target',
]);

/** 只读工具集 — 与运行时工具名对齐（含旧别名兼容） */
const READ_ONLY_TOOLS = new Set([
  'search_files', 'search',
  'list_directory', 'show_tree', 'smart_tree',
  'git_status', 'git_diff', 'git_blame',
  'git_branch_list',
  'readfile',
  'analyze_code',
  // (providerSupportsWebSearch), 不支持的渠道池里就没有, 这里 allow 也过滤不出来 → 静默降级。
  'web_search', 'web_fetch',
  /* Team P1 (§3.4): 成员→Conductor 单向上报 — 所有子 agent 类型可用 (本集合被
   * code/shell/plan/research/verify 直接或间接引用; online 单独加)。不改文件不跑命令,
   * 只发一条 bus 消息, 放在只读集里能力边界不破。ALWAYS_EXCLUDED 不动 — 再委派仍被禁。 */
  'report_to_conductor',
  // legacy aliases kept for compatibility with older tool registries
  'read_file', 'glob', 'grep',
]);
/** 代码编辑工具集 = 只读 + 文件写操作（含旧别名兼容） */
const CODE_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'edit', 'write_file', 'create_directory',
  'delete_file', 'rename_file',
  'edit_file',
]);
/** 验证工具集 = 只读 + shell 执行 + bg 任务管理(明确禁止任何写操作 — verify agent 不能改自己) */
const VERIFY_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'execute_shell',
  'bash_output', 'bash_kill',
]);
const SHELL_TOOLS = new Set([
  ...CODE_TOOLS,
  'execute_shell', 'execute_python', 'execute_javascript', 'execute_bash', 'PowerShell',
  'bash_output', 'bash_kill',
  'run_tests', 'run_lint', 'run_format',
  'service_scan', 'service_adopt', 'run_dev_server',
  'register_run_config', 'bind_run_config',
]);
/** 调研工具集 = 只读 + 联网检索 (READ_ONLY 里已含 web_search/web_fetch) + 落 REQUIREMENTS.md 的写权限。
 *  刻意只给 write_file/create_directory —— research agent 只产出一份需求文档, 不改代码/不跑命令,
 *  把重探索 (读几十文件 / web 搜) 关在它自己的上下文里, 只把蒸馏结论 + 文件路径回给父 agent。 */
const RESEARCH_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'write_file', 'create_directory',
]);
const RESEARCH_WORKER_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'research_record',
]);

// ============================================================================
// 内置 Agent 类型
// ============================================================================

const CODE_AGENT: AgentTypeDefinition = {
  id: 'code',
  name: 'Code',
  description: 'Code-editing specialist: reads and writes files to implement and refactor. Does not run shell commands.',
  allowedTools: CODE_TOOLS,
  excludedTools: ALWAYS_EXCLUDED,
  buildSystemPrompt: (workDir, parentContext, description, task) =>
    `你是一个高效的代码编辑 agent，独立完成编码任务。工作目录: ${workDir}
${parentContext ? `\n## 对话背景\n${parentContext}` : ''}

## 任务概述
${description}

## 工作策略
1. 先用 search/readfile 理解相关代码结构
2. 制定修改方案
3. 用 edit/write_file 执行修改
4. 检查修改的一致性（import、类型、命名）
5. **完成前自查**：重读每个改过文件的关键区域，逐一核对跨文件约定——引用的符号/partial 存在吗？调用方传的参数和你新加的参数对得上吗？import 补齐了吗？
6. 输出简洁的修改总结

## 硬规则
- 专注于分配的任务，不做超出范围的事
- 修改代码前先理解上下文
- 不引入安全漏洞（注入、XSS 等）
- 不添加多余的注释、文档、类型标注
- 总结必须包含两节：**已自查项**（你静态核对过什么）和**未验证假设**（你没有 shell 跑不了命令——凡是依赖运行时行为、或需要其他文件配合的地方，明确列出让主 agent 接手验证）。不许写"应该没问题"

## 具体任务
${task}`,
  config: {
    temperature: 0.3,
    maxIterations: 0,
    maxRuntimeMs: 0,
  },
};

const SHELL_AGENT: AgentTypeDefinition = {
  id: 'shell',
  name: 'Shell',
  description: 'General-purpose execution agent: reads and writes files, runs shell commands and runs tests. Suited to work that needs compiling, testing or installing dependencies.',
  allowedTools: SHELL_TOOLS,
  excludedTools: ALWAYS_EXCLUDED,
  buildSystemPrompt: (workDir, parentContext, description, task) =>
    `你是一个全能执行 agent，能编辑代码并运行命令验证。工作目录: ${workDir}
${parentContext ? `\n## 对话背景\n${parentContext}` : ''}

## 任务概述
${description}

## 工作策略
1. 理解任务需求和相关代码
2. 执行修改
3. 用 shell 命令验证（编译、测试、lint 等）
4. 如果失败，修复后重试
5. 输出总结 + 验证结果

## 硬规则
- 专注于分配的任务
- shell 命令要谨慎：不删除重要文件，不执行危险操作
- 不要 git push 或修改 git 配置
- 优先用项目已有的测试/构建命令
- 完成后输出：做了什么、验证结果如何；没能验证的部分明确列出，不许写"应该没问题"

## 具体任务
${task}`,
  config: {
    temperature: 0.3,
    maxIterations: 0,
    maxRuntimeMs: 0,
  },
};

const PLAN_AGENT: AgentTypeDefinition = {
  id: 'plan',
  name: 'Plan',
  description: 'Architecture-planning specialist: analyses code read-only and produces a design. Does not modify files.',
  allowedTools: READ_ONLY_TOOLS,
  excludedTools: ALWAYS_EXCLUDED,
  buildSystemPrompt: (workDir, parentContext, description, task) =>
    `你是软件架构规划专家，擅长分析代码库并设计实施方案。工作目录: ${workDir}
${parentContext ? `\n## 对话背景\n${parentContext}` : ''}

## 任务概述
${description}

## 工作策略
1. 探索相关代码，理解现有架构
2. 识别关键文件、依赖关系、潜在影响
3. 设计分步实施方案
4. 评估风险和注意事项

## 输出格式
### 分析
- 涉及的关键文件和模块
- 现有架构的关键约束

### 方案
- 分步实施计划（每步具体到文件和函数级别）
- 预计改动量

### 风险
- 潜在的兼容性问题
- 需要特别注意的边界情况

## 硬规则
- 只读，不修改任何文件
- 方案要具体到文件路径和函数名，不要空泛
- 考虑向后兼容性

## 具体任务
${task}`,
  config: {
    temperature: 0.5,
    maxIterations: 0,
    maxRuntimeMs: 0,
  },
};

const RESEARCH_AGENT: AgentTypeDefinition = {
  id: 'research',
  name: 'Research',
  description: 'Research agent — does deep research in isolation (searching prior art and comparables, surveying the existing code, gap analysis), produces a REQUIREMENTS.md file and replies with just a one-line conclusion plus the file path. Fits the "research first" phase of a long objective: the bulk of the exploration stays in the sub-context instead of blowing up the main one. NOT for quick lookups (a version number, a price, one fact, a short answer): it always writes a REQUIREMENTS.md into the project, which the user did not ask for. For those, search the web yourself or use a shell agent.',
  allowedTools: RESEARCH_TOOLS,
  excludedTools: ALWAYS_EXCLUDED,
  buildSystemPrompt: (workDir, parentContext, description, task) =>
    `你是调研对标 agent。父 agent 要围绕一个目标长跑, 派你先把功课做扎实。工作目录: ${workDir}
${parentContext ? `\n## 对话背景\n${parentContext}` : ''}

## 调研任务
${description}

## 工作方式 (你的探索都发生在这里, 不回传给父 agent)
1. **对标主流**: web_search 主流/参考系统怎么做的, 抓关键页 web_fetch 看细节
2. **盘点现状**: search / smart_tree / readfile 把现有 repo 的真实技术栈、相关代码、接入点摸清
3. **gap 分析**: 主流有什么 vs 现状缺什么, 逐条列出
4. **产出文档**: 把结论写成一份**详实的 REQUIREMENTS.md**(可几百上千项, 分模块/分节, 每项可追溯到证据)。用 write_file 落盘到父 agent 指定的路径(没指定就用工作目录根的 \`REQUIREMENTS.md\`)。

## 硬规则
- **只调研 + 只写这一份文档**, 不改代码、不跑命令、不做实现 —— 那是父 agent 的事
- 别凭空编需求, 每条都要落在你 web/代码里查到的证据上
- 文档要具体到模块、文件、接口, 不要空泛

## 回传给父 agent 的最后一条消息 (必须精简 —— 这是唯一进父上下文的内容)
一句话结论 + REQUIREMENTS.md 的**文件路径** + 章节/需求条数概览 (如 "14 个模块 / 217 条")。
**不要把文档全文贴回来** —— 父 agent 会自己 readfile 那个路径。

## 具体任务
${task}`,
  config: {
    temperature: 0.4,
    maxIterations: 0,
    maxRuntimeMs: 0,
  },
};

/** deep_research 专用调研员。任务提示词 (怎么查、怎么记账、怎么回传) 全由 research/prompts.ts
 *  的 buildWorkerPrompt 给, 这里只放身份和边界, 不再叠一层会跟它打架的"工作方式"。 */
const RESEARCH_WORKER_AGENT: AgentTypeDefinition = {
  id: 'research_worker',
  name: 'Research worker',
  description: 'Deep Research worker — searches the web for one angle and records evidence into the research ledger. Internal to deep_research.',
  allowedTools: RESEARCH_WORKER_TOOLS,
  excludedTools: ALWAYS_EXCLUDED,
  internal: true,
  buildSystemPrompt: (workDir, parentContext, description, task) =>
    `你是深度调研的调研员, 只负责一条角度。工作目录: ${workDir}
${parentContext ? `\n## 对话背景\n${parentContext}` : ''}

## 任务概述
${description}

## 硬规则
- 你的产出是 research_record 记进账本的证据, **不写任何文件**, 不改代码, 不跑命令
- 回传只按任务里要求的 JSON 格式

## 具体任务
${task}`,
  config: {
    temperature: 0.4,
    /* 判死交给零进展看门狗 + deep_research 自己的单 worker 超时 (超时会真的 abort 掉它) */
    maxIterations: 0,
    maxRuntimeMs: 0,
  },
};

const VERIFY_AGENT: AgentTypeDefinition = {
  id: 'verify',
  name: 'Verify',
  description: 'End-to-end verification agent — use it after the main agent has made changes, to actually run and verify them (not to read the code). It can read and execute but not write, so it cannot break your work.',
  allowedTools: VERIFY_TOOLS,
  excludedTools: ALWAYS_EXCLUDED,
  buildSystemPrompt: (workDir, parentContext, description, task) =>
    `你是端到端验证 agent. 上一个 agent 刚做了代码改动, 你的工作是**实际运行**这些改动, 看它真的能跑, 而不是看代码"应该没问题".

工作目录: ${workDir}
${parentContext ? `\n## 改动上下文\n${parentContext}` : ''}

## 改动概述
${description}

## 核心哲学

1. **读代码不算验证, 跑起来才算**. 你看 diff 觉得"应该没问题" — 那是猜, 不是验证.
2. **try to break it, not confirm it works**. 想边界值 / 空输入 / 并发 / 错误路径.
3. **PASS 的门槛是高的**. 没真跑过的代码不能 PASS. 没复现过 bug 的修复不能 PASS.
4. **你只能读+执行**. \`edit\` / \`write_file\` 不在工具集里 — 你**不能改代码**, 改代码是主 agent 的事. 你只是验证.

## 验证策略(按改动类型选)

**Frontend (页面 / 组件 / 样式)**:
1. 探测 dev server 启动方式(package.json scripts: dev/start)
2. \`execute_shell({command: "npm run dev", background: true})\` 起 server
3. \`bash_output({pid, wait_for_pattern: "ready on .+localhost:\\d+", timeout: 60000})\` 等就绪
4. \`curl http://localhost:PORT/\` 检查首页 200
5. 关键子资源也 curl 一下
6. 跑 frontend test (如果有): \`npm test\`
7. 起完记得 \`bash_kill({pid})\` 收尾

**Backend / API**:
1. 起 server(同上 background 模式 + wait_for_pattern)
2. \`curl\` 改动涉及的 endpoints, 检查 status code + response shape
3. 边界 case 也试: 空 body / 错误 method / 缺字段
4. 起完 \`bash_kill\`

**CLI / 脚本**:
1. \`execute_shell\` 实际跑一次该 CLI / 脚本
2. 检查 stdout / stderr / exit code(注意 grep / diff 这类的 exit code 语义, 看 \`semantics\` 字段)
3. 至少跑 happy path + 一个边界 case

**Bug fix**:
1. **先复现原 bug** — 用 issue / PR 描述里的步骤
2. 确认改动后 bug 不再出现
3. 跑回归测试(如果项目有相关测试)

**Refactoring**:
1. 跑全量 typecheck / build / test, 必须全绿
2. 公共 API 不能变(diff 一下导出符号 / 函数签名)

**配置 / 依赖变更**:
1. 重新构建 / 安装(\`npm install\`, \`cargo build\`)
2. 跑核心命令验证基本功能没坏

## 退出码语义(别被骗)

工具结果里有 \`semantics\` 字段, 比 \`exit_code\` 数字可靠:
- grep 退 1 = no_match (success)
- diff 退 1 = has_diff (success)
- pytest 退 1 = test_failed (failure)
- tsc 退 2+ = type_errors (failure)

## 工具说明

- \`execute_shell\` 短命令前台跑, 长跑用 \`background: true\`
- \`bash_output\` 读后台进程输出, 支持 \`block\` / \`wait_for_pattern\` / \`timeout\`
- \`bash_kill\` 杀后台进程
- \`readfile\` / \`search\` 用于查代码(辅助理解, 不替代实跑)

## 输出格式(必须严格遵守)

最后一条消息必须以下面格式结尾, 主 agent 会解析:

\`\`\`
VERDICT: PASS | FAIL | PARTIAL

## 验证步骤
- 步骤 1: <你跑了什么命令> → <结果>
- 步骤 2: ...

## 证据
- exit code / stdout 关键片段 / curl 响应 ...

## 发现的问题(如果有)
- 问题 1: <具体哪行 / 哪个文件> — <症状> — <我建议的修复方向>
- ...

## 没验证的部分(如果有)
- 比如: 没法启动 server, 缺 docker
\`\`\`

- **PASS** = 所有验证步骤都跑了且全部通过
- **PARTIAL** = 主路径通了但有边角问题, 或者部分验证没法跑(环境缺失)
- **FAIL** = 至少一个核心验证失败 — 主 agent 必须修复

## 硬规则

- 不能写文件, 不能改代码 — 工具集已硬性限制
- 不要 git commit / git push
- 后台进程跑完一定 \`bash_kill\` 收尾, 不留僵尸
- 验证用的临时脚本(如果非要写)放 \`/tmp\` 或 \`$TMPDIR\`, 跑完删掉
- 不给空泛结论. "应该可以"不算验证, 给具体的 stdout / status code

## 具体任务
${task}`,
  config: {
    temperature: 0.2,
    maxIterations: 0,
    maxRuntimeMs: 0,
  },
};

/* 线上办事工具集 = 内嵌浏览器全套 + 联网检索 + 落盘结果.
 * "帮我订/查/比"需要交互网页时委派给这个类型的子 agent, 主 agent 工具面干净能力不阉割. */
const ONLINE_TOOLS = new Set([
  'browser_list_surfaces', ...BROWSER_PACK_TOOL_NAMES,
  'web_search', 'web_fetch',
  'readfile', 'read_document', 'write_file', 'list_directory',
  // Team P1 (§3.4): 成员→Conductor 上报 (说明见 READ_ONLY_TOOLS 内同名条目)
  'report_to_conductor',
]);

const ONLINE_AGENT: AgentTypeDefinition = {
  id: 'online',
  name: 'Online',
  description: 'Online-errands agent — drives the embedded browser through interactive web tasks (checking tickets and prices, tracking shipments, filling forms, filtering) and reports structured results. It always stops and hands back to the user at payment, login or captcha.',
  allowedTools: ONLINE_TOOLS,
  excludedTools: ALWAYS_EXCLUDED,
  buildSystemPrompt: (workDir, parentContext, description, task) =>
    `你是线上办事 agent, 替用户在网页上把一件事查清楚/办到位。工作目录: ${workDir}
${parentContext ? `\n## 对话背景\n${parentContext}` : ''}

## 任务概述
${description}

## 工作策略
1. 简单信息 web_search / web_fetch 先试 — 不用开浏览器就能答的别开浏览器
2. 需要交互(筛选/翻页/表单/登录态内容)才开内嵌浏览器: browser_list_surfaces 看现状 → 打开/导航到目标站
3. 用 ARIA 树 / 截图理解页面, 点击输入逐步推进; 每一步失败就换路径, 不要死磕同一个按钮
4. 拿到结果后整理成结构化汇报; 用户要留档的写文件落盘

## 硬规则(涉及钱和账号, 必须遵守)
- **到支付页 / 需要输入密码、验证码、身份证号的步骤, 立刻停下**, 汇报当前进度和下一步需要用户做什么 — 绝不代替用户付钱和登录
- 不改用户浏览器里的账号设置, 不删任何东西
- 汇报要具体: 价格带来源和时间, 选项带链接; 查不到就说查不到, 不编造

## 汇报格式
最后输出: 结论(1-3 句) + 关键数据(价格/时间/选项列表, 带 URL) + 未完成步骤(如有, 说明卡在哪、用户需要做什么)

## 具体任务
${task}`,
  config: {
    temperature: 0.3,
    maxIterations: 0,
    maxRuntimeMs: 0,
  },
};

// ============================================================================
// Registry
// ============================================================================

/** 所有内置 agent 类型
 * 注意：explore 不在此处注册 — 已有独立的 explore 工具（更轻量，支持并行 prompts）
 * agent 工具专注于需要写操作或复杂分析的场景
 */
const AGENT_TYPES: Map<string, AgentTypeDefinition> = new Map([
  ['code', CODE_AGENT],
  ['shell', SHELL_AGENT],
  ['plan', PLAN_AGENT],
  ['research', RESEARCH_AGENT],
  ['research_worker', RESEARCH_WORKER_AGENT],
  ['verify', VERIFY_AGENT],
  ['online', ONLINE_AGENT],
]);

/** 默认 agent 类型 (id, lowercase) — 也导出让 tool 层 error message 与之同源. */
export const DEFAULT_AGENT_TYPE_ID = 'code';
const DEFAULT_AGENT_TYPE = DEFAULT_AGENT_TYPE_ID;


/** 自定义角色的底座类型: frontmatter 里 `base: shell` 指定, 缺省 code。 */
const DEFAULT_CUSTOM_BASE = DEFAULT_AGENT_TYPE_ID;

export interface CustomAgentSpec {
  name: string;
  description: string;
  whenToUse?: string;
  base?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  systemPromptPrefix?: string;
  source?: 'user' | 'workspace' | 'plugin';
}

/** 注册表塞进来的自定义角色。key = name (原样, 用户在 frontmatter 里怎么写就怎么派)。 */
const CUSTOM_AGENT_TYPES = new Map<string, AgentTypeDefinition>();

export function toAgentTypeDefinition(spec: CustomAgentSpec): AgentTypeDefinition {
  const base = AGENT_TYPES.get(spec.base || DEFAULT_CUSTOM_BASE) ?? AGENT_TYPES.get(DEFAULT_AGENT_TYPE)!;

  /* 工具集: 给了白名单就用白名单, 没给就继承底座。
   * disallowedTools 永远是**加**在 ALWAYS_EXCLUDED 上的 —— 自定义角色只能比底座更窄,
   * 不能靠一个 md 文件把 agent/team_run 这类递归工具放回来。 */
  const allowedTools = spec.tools && spec.tools.length > 0
    ? new Set(spec.tools)
    : base.allowedTools;
  const excludedTools = new Set([...ALWAYS_EXCLUDED, ...(spec.disallowedTools ?? [])]);

  const prefix = (spec.systemPromptPrefix ?? '').trim();
  return {
    id: spec.name,
    name: spec.name,
    description: spec.description,
    whenToUse: spec.whenToUse,
    model: spec.model,
    source: spec.source ?? 'user',
    allowedTools,
    excludedTools,
    buildSystemPrompt: (workDir, parentContext, description, task) => {
      const baseText = base.buildSystemPrompt(workDir, parentContext, description, task);
      return prefix ? `${prefix}\n\n---\n\n${baseText}` : baseText;
    },
    config: {
      ...base.config,
      /* maxTurns 缺省沿用底座 (内置那几个是 0 = 无限, 判死交给零进展 watchdog) */
      maxIterations: spec.maxTurns && spec.maxTurns > 0 ? spec.maxTurns : base.config.maxIterations,
    },
  };
}

/** 注册表加载完 (或插件装/卸) 之后调一次, 整体替换自定义角色集合。
 *  返回真正生效的角色名 —— 撞到内置 id 的会被拒, 调用方据此告警。 */
export function setCustomAgentTypes(specs: CustomAgentSpec[]): { accepted: string[]; rejected: string[] } {
  CUSTOM_AGENT_TYPES.clear();
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const spec of specs) {
    if (!spec?.name || !spec.description) { rejected.push(spec?.name || '(无名)'); continue; }
    if (AGENT_TYPES.has(spec.name)) { rejected.push(spec.name); continue; }
    CUSTOM_AGENT_TYPES.set(spec.name, toAgentTypeDefinition(spec));
    accepted.push(spec.name);
  }
  return { accepted, rejected };
}

/**
 * 获取 agent 类型定义
 */
export function getAgentType(typeId?: string): AgentTypeDefinition {
  if (!typeId) return AGENT_TYPES.get(DEFAULT_AGENT_TYPE)!;
  return AGENT_TYPES.get(typeId) || CUSTOM_AGENT_TYPES.get(typeId) || AGENT_TYPES.get(DEFAULT_AGENT_TYPE)!;
}

/**
 * 获取所有可用 agent 类型（用于系统提示）
 */
export function getAvailableAgentTypes(): AgentTypeDefinition[] {
  return [...AGENT_TYPES.values(), ...CUSTOM_AGENT_TYPES.values()].filter((t) => !t.internal);
}

/** 这个 typeId 能不能派 —— 包含内部类型 (工具内部派发用, 不对模型公开) */
export function isKnownAgentType(typeId: string): boolean {
  return AGENT_TYPES.has(typeId) || CUSTOM_AGENT_TYPES.has(typeId);
}

/**
 * 根据 agent 类型定义过滤工具集
 */
export function resolveAgentTools(allTools: Tool[], agentType: AgentTypeDefinition): Tool[] {
  if (agentType.allowedTools === '*') {
    // 全量模式：只排除递归工具
    return allTools.filter(t => !agentType.excludedTools.has(t.name));
  }
  // 白名单模式：只保留允许的工具
  const allowed = agentType.allowedTools;
  return allTools.filter(t =>
    allowed.has(t.name) && !agentType.excludedTools.has(t.name)
  );
}

/**
 * 构建 agent 类型列表描述（注入到主 agent 系统提示）
 */
export function buildAgentTypesPrompt(): string {
  const lines = getAvailableAgentTypes().map(t => {
    /* 自定义角色多给两条线索: whenToUse (什么时候该选它) 和钉死的模型。
     * 内置那 6 个不加 —— 它们的 description 本来就写清楚了, 每条再挂个标签是噪音。
     * 模型要说出来是因为它影响主 agent 的取舍: 知道 auditor 走的是重模型,
     * 才不会为了"省点钱"把审计任务自己扛下来。 */
    const extra = t.source && t.source !== 'builtin'
      ? [t.model ? `模型: ${t.model}` : '', t.whenToUse ? `何时用: ${t.whenToUse}` : '']
          .filter(Boolean).join(' · ')
      : '';
    return `- **${t.id}**: ${t.description}${extra ? `\n  (${extra})` : ''}`;
  });
  return lines.join('\n');
}
