/**
 * Built-in Tool Packs — 内置工具包定义
 *
 * 完整盘点 Neox 全部工具，分类到 ToolPack。
 * 三层架构：
 *   Tier 0: Always-Active (14 个常驻，原生 function calling)
 *   Tier 1: Primary Packs (高频工具包，tool_search 目录优先展示)
 *   Tier 2: Extended Packs (特定场景工具包，tool_search 精确搜索)
 *
 * 缓存友好: tools 数组 = 常驻 + tool_search + call_tool，固定不变
 */

import type { ToolPack } from './toolPack.js';
import { BROWSER_PACK_TOOL_NAMES, MODEL_FACING_BROWSER_TOOL_NAMES } from '../../runtime/browser/browserToolDefs.js';
import { COMPUTER_TOOL_NAMES } from '../../runtime/computer/computerToolDefs.js';
import { WORD_TOOL_NAMES } from '../word/wordTools.js';

/* sheet 工具名硬编码避免 builtinPacks  tools 循环依赖 — 跟 sheetTools.ts/sheetWriteTools.ts 保持一致.
 * 6 件套: describe / get_range (读) + new_workbook / write_range / export_file (写) + export (转格式). */
const SHEET_TOOL_NAMES = [
  'sheet_describe', 'sheet_get_range',
  'sheet_new_workbook', 'sheet_write_range', 'sheet_export_file',
  'sheet_export',
  /* 原地改已有 .xlsx (保公式/样式/透视) */
  'sheet_set_cells',
];

// ==================== Primary Packs (高频) ====================

export const fileOpsPack: ToolPack = {
    id: 'file_ops',
    label: '文件操作',
    icon: '▸',
    description: 'File creation, line-based editing, deletion, renaming, directory creation',
    group: 'core',
    tier: 'primary',
    keywords: ['file', 'write', 'create', 'delete', 'rename', 'directory', 'mkdir'],
    builtin: true,
    /* 不加 modes: Life 场景 write_file 常用 (Life alwaysActive 里就有), 且 tool_search
     * 需要能拉到 edit/delete_file 让 agent 修改用户拖入文件. */
    toolNames: [
        'write_file', 'edit', 'edit_batch', 'delete_file',
        'rename_file', 'create_directory',
    ],
};

export const codeSearchPack: ToolPack = {
    id: 'code_search',
    label: '搜索与浏览',
    icon: '▹',
    description: 'Content search (grep), file search (glob), directory browsing, smart file reading',
    group: 'core',
    tier: 'primary',
    keywords: ['search', 'grep', 'find', 'glob', 'read', 'tree'],
    builtin: true,
    /* 不加 modes: readfile Life 也要 (alwaysActive 里就有), search / list_directory 让
     * agent 拉到用户拖入的文件夹. 符号/索引/分析类纯 dev 工具已拆去 codeIntelPack
     * (modes:['code']) — Life 的 tool_search 目录不再出现 search_symbol 这类东西. */
    toolNames: [
        'search', 'search_files', 'readfile',
        'list_directory', 'show_tree', 'smart_tree',
        'read_document',
    ],
};

/* 代码智能：符号索引、定义引用和代码分析仅属于开发工具面。 */
export const codeIntelPack: ToolPack = {
    id: 'code_intel',
    label: '代码智能',
    icon: '▹',
    description: 'Code structure analysis, symbol indexing, jump to definition/references',
    group: 'core',
    tier: 'primary',
    keywords: ['symbol', 'index', 'analyze', 'definition', 'reference', 'ast'],
    builtin: true,
    modes: ['code'],
    toolNames: [
        'analyze_code',
        'build_index', 'search_symbol',
        'get_definitions', 'get_references',
    ],
};

/* 拆包: 「跑一条命令」和「开发环境管理」是两件事, 之前挤在 executePack 里
 * 一起标 modes:['code'], 结果 Work 模式一条命令都执行不了 —— pptx-deck-writer 这类
 * 「写 .mjs → node 跑」的技能路线在工作模式里是死胡同 (技能教你写脚本, 工具面不给你跑)。
 *
 * 取舍: 只把**执行原语**放开给 work, dev 专用的那批 (service_scan/adopt · run_dev_server ·
 * register/bind_run_config · execute_python/javascript/bash · PowerShell) 全部留在 code。
 * 理由: 办公场景需要的是"跑我刚写的那个脚本", 不是"接管我的 dev server"; 后者对白领是纯噪音,
 * 且每个都要额外 schema 预算。git / debug / worktree / code_intel 同理, 一个都不开。
 *
 * bash_output / bash_kill 跟着 execute_shell 走 —— 命令一旦超时转后台, 没这两个就读不到结果。 */
export const scriptExecPack: ToolPack = {
    id: 'script_exec',
    label: '命令与脚本执行',
    icon: '►',
    description: 'Run shell commands and scripts, plus reading output from and terminating background tasks.',
    group: 'core',
    tier: 'primary',
    keywords: ['shell', 'bash', 'run', 'exec', 'command', 'script', 'node',
               '命令', '执行', '脚本', '跑'],
    builtin: true,
    modes: ['work', 'code'],
    toolNames: [
        'execute_shell',
        'bash_output', 'bash_kill',
    ],
};

export const executePack: ToolPack = {
    id: 'execute',
    label: '开发环境与服务管理',
    icon: '►',
    description: 'Multi-language interpreter execution (python/javascript/bash/PowerShell), service discovery and adoption (service_scan/service_adopt), dev server management',
    group: 'core',
    tier: 'primary',
    keywords: ['python', 'javascript', 'powershell', 'interpreter',
               'service', 'port', 'process', 'adopt', 'scan', 'server', 'dev'],
    builtin: true,
    modes: ['code'],
    toolNames: [
        'execute_python',
        'execute_javascript', 'execute_bash',
        'PowerShell',
        'service_scan', 'service_adopt',
        'register_run_config', 'bind_run_config',
        'run_dev_server',
    ],
};

export const qualityPack: ToolPack = {
    id: 'quality',
    label: '代码质量',
    icon: '◻',
    description: 'Run tests, lint checks and code formatting',
    group: 'core',
    tier: 'primary',
    keywords: ['test', 'lint', 'format', 'quality', 'check', 'ci'],
    builtin: true,
    modes: ['code'],
    toolNames: [
        'run_tests', 'run_lint', 'run_format', 'index_stats',
        'read_lints', /* IDE Monaco 诊断 — 常驻 ALWAYS_ACTIVE, 也挂在 quality 包便于发现 */
    ],
};

// ==================== Primary: VCS 版本控制 ====================

export const gitPack: ToolPack = {
    id: 'git',
    label: 'Git 版本控制',
    icon: '◇',
    description: 'Git status, diffs, blame, branch management, commits',
    group: 'vcs',
    tier: 'primary',
    keywords: ['git', 'branch', 'commit', 'diff', 'status', 'blame', 'merge', 'rebase'],
    builtin: true,
    modes: ['code'],
    toolNames: [
        'git_status', 'git_diff', 'git_blame',
        'git_branch_list', 'git_branch', 'git_commit',
    ],
};

// ==================== Primary: Web 网络 ====================

export const webPack: ToolPack = {
    id: 'web',
    label: '网页抓取与搜索',
    icon: '◈',
    description: 'Web fetch and web search. Browser interaction lives in browserPack (the embedded browser surface).',
    group: 'web',
    tier: 'primary',
    keywords: ['web', 'fetch', 'url', 'http', 'search'],
    builtin: true,
    toolNames: ['web_fetch', 'web_search'],
};

/* Browser Surface 交互工具包 — 30+ 个 browser_* 工具.
 * 入口 browser_list_surfaces 是常驻 (BASE_TOOLS), 这里是后续交互/读取的完整包.
 * agent 看到 list_surfaces 返回 "有 N 个浏览器" 后, 调 tool_search('browser') 解锁全部. */
export const browserPack: ToolPack = {
    id: 'browser',
    label: '浏览器自动化',
    icon: '◉',
    description: 'Embedded browser automation. Drive the browser with browser_run — ONE call runs a whole '
               + 'SCRIPT of actions (click/type/wait/assert) locally; measured 14ms per action on a real site, '
               + 'versus ~20s per action if you call step tools one at a time. '
               + 'The other tools here are for LOOKING (aria tree / screenshot / query) and for session '
               + 'management (storage state, diagnose) — do the DOING in browser_run. '
               + '入口 browser_list_surfaces 常驻; 此包通过 tool_search 解锁.',
    group: 'web',
    tier: 'primary',
    keywords: ['browser', 'screenshot', 'click', 'type', 'navigate', 'aria',
               'cookies', 'localstorage', 'network', 'console', 'mock', 'playwright',
               '浏览器', '截屏', '点击', '页面'],
    builtin: true,
    modes: ['work', 'code'], /* Life 用户不玩浏览器自动化 (55 tools 太吓人) */
    /* pack 清单包含完整实现集合；unlockToolNames 决定实际向模型公开的子集。 */
    toolNames: BROWSER_PACK_TOOL_NAMES,
    /* 解锁时交给模型的工具子集；单步实现留在 toolMap 供 browser_run 本地调用。 */
    unlockToolNames: MODEL_FACING_BROWSER_TOOL_NAMES,
    useFor: 'Doing things on websites and web apps: open a site, search, shop, book, '
          + 'read posts or comments, log into dashboards and export data, fill forms, screenshot pages',
    /* 预判命中只给跑流程 + 看页面这几个 (同 agenticRuntime 的 PRE_UNLOCK_BROWSER) */
    preloadToolNames: [
      'browser_run', 'browser_replay',
      'browser_get_aria_tree', 'browser_get_state', 'browser_screenshot', 'browser_get_text',
    ],
};

/* Computer Use 是 macOS 的 OS 级工具。只有 isComputerUseEnabled() 允许装配时，工具
 * 才进入 toolMap 并出现在目录中；pack 定义始终保留，以维持工具分类和解锁边界。 */
export const computerPack: ToolPack = {
    id: 'computer',
    label: '电脑操作 (macOS)',
    icon: '▣',
    description: 'Drive native macOS apps: read the numbered element list with computer_snapshot, then run a '
               + 'whole SCRIPT of actions in ONE computer_run call (measured 0-130ms per action, versus a full '
               + 'model round-trip per action if done one at a time). Uses accessibility actions, so it works '
               + 'while the target app is in the BACKGROUND and never moves the user cursor. '
               + 'Not for web pages (use browserPack) and never for terminals (use the shell tools). '
               + '默认不携带 —— 装了 computer-use 插件才出现。',
    group: 'platform',
    tier: 'primary',
    keywords: ['computer', 'macos', 'gui', 'accessibility', 'click', 'keyboard',
               '电脑', '操作', '桌面', '应用', '自动化'],
    builtin: true,
    modes: ['work', 'code'],
    toolNames: COMPUTER_TOOL_NAMES,
};

/* Sheet (Excel/CSV) 编辑工具包；处理表格时通过 tool_search({pack: 'sheet'}) 解锁。 */
export const sheetPack: ToolPack = {
    id: 'sheet',
    label: '表格 (Excel/CSV)',
    icon: '⊞',
    description: 'Read and write .xlsx/.csv/.tsv: structure overview / read a range as a markdown table (optionally with formulas) / ' +
                 'edit cells IN PLACE in the user\'s existing .xlsx keeping formulas, styles, charts and pivots (sheet_set_cells) / ' +
                 'create a new in-memory workbook / 写 cell 区域 / 导出 .xlsx. Univer + SheetJS 双引擎, viewer 双向同步.',
    group: 'data',
    tier: 'primary',
    keywords: ['sheet', 'excel', 'xlsx', 'csv', 'tsv', 'workbook', 'cell', 'spreadsheet',
               '表格', '工作表', '单元格', '电子表格', '表'],
    builtin: true,
    modes: ['work', 'code'],
    toolNames: SHEET_TOOL_NAMES,
};

/* Word 文档编辑工具包 — word_* 工具, 全部 pack 模式不进 ALWAYS_ACTIVE.
 * agent 处理 .docx 文件 / 用户要"改文档"时, tool_search({pack:'word'}) 解锁.
 * 实现: jszip 解 .docx + 操作 word/document.xml, 保留 100% 原格式 (主题/字体/样式/图表). */
export const wordPack: ToolPack = {
    id: 'word',
    label: 'Word 文档编辑',
    icon: '◫',
    description: 'Create and edit .docx Word documents: new document / browse paragraphs / global text replace / paragraph-level editing / insert and delete. ' +
                 'jszip + OOXML 直接改, 不解构重建, 保留原格式 (主题/字体/页边距/图表).',
    group: 'data', /* docs/spreadsheets 都归 data — 没有专门的 docs group */
    tier: 'primary',
    keywords: ['word', 'docx', 'document', 'paragraph', 'replace', 'edit', 'heading',
               '文档', '段落', '替换', '编辑', '改文章', '改段落', 'word 编辑', 'docx 编辑'],
    builtin: true,
    modes: ['work', 'code'],
    toolNames: WORD_TOOL_NAMES,
    /* 预判命中先给看 + 改文字这几个; 表格/图片/导出等照旧 tool_search */
    preloadToolNames: [
      'word_describe', 'word_get_paragraphs', 'word_replace_text',
      'word_edit_paragraph', 'word_insert_paragraph', 'word_create',
    ],
};

// ==================== Primary: Agent 协作 ====================

export const agentPack: ToolPack = {
    id: 'agent',
    label: '任务 Agent',
    icon: '●',
    description: 'PTC batch orchestration across multiple tools',
    group: 'agent',
    tier: 'primary',
    keywords: ['ptc', 'orchestrate', 'batch', 'agent', 'delegate', 'subagent', 'dispatch',
               'message', 'send', 'list', 'parallel', '派遣', '委派', '子任务', '通信', '并行'],
    builtin: true,
    modes: ['code'],
    /* explore 和 agent 保持常驻；子 agent 通信工具仅在该 pack 解锁后可见。 */
    toolNames: ['ptc_execute', 'agent', 'send_message', 'list_agents', 'stop_agent'],
};

/* 团队工具按需解锁；unlockTogether 保证团队工作流需要的同包工具一并可用，且跨模式可用。 */
export const teamPack: ToolPack = {
    id: 'team',
    label: '团队',
    icon: '◎',
    description: 'Team mode for a big goal: decompose → staff → members claim work, then execute once the user says go',
    group: 'agent',
    tier: 'primary',
    keywords: ['team', 'squad', 'lane', 'decompose', 'roster', 'claim', 'meeting', 'execute',
               '团队', '开团', '拆解', '编制', '认领', '成员'],
    builtin: true,
    unlockTogether: true,
    toolNames: ['team_run', 'team_decompose', 'team_prune', 'team_roster', 'team_member_review', 'team_claim', 'team_meeting', 'team_execute'],
};

export const systemPack: ToolPack = {
    id: 'system',
    label: '系统工具',
    icon: '◦',
    description: 'Task plan management, skill invocation, user interaction, context and budget self-checks',
    group: 'agent',
    tier: 'primary',
    keywords: ['plan', 'skill', 'ask', 'user', 'question', 'context', 'status', 'budget'],
    builtin: true,
    /* 不加 modes: ask_user 常驻要有 (Life alwaysActive 里就有), 其他 update_plan /
     * use_skill / context_status Life 用不上但保留 pack, tool_search 能查到时再拉. */
    toolNames: ['update_plan', 'use_skill', 'ask_user', 'context_status'],
};

export const memoryPack: ToolPack = {
    id: 'memory',
    label: '项目记忆',
    icon: '○',
    description: 'Read, save and update project memory — knowledge that persists across sessions',
    group: 'agent',
    tier: 'primary',
    /* 'knowledge' 关键词已让位给 knowledgePack — 避免 tool_search 歧义 */
    keywords: ['memory', 'remember', 'recall', 'save', 'persist'],
    builtin: true,
    toolNames: ['read_memory', 'save_memory', 'update_project_memory', 'memory'],
};

export const knowledgePack: ToolPack = {
    id: 'knowledge',
    label: '知识库',
    icon: '◆',
    description: 'Search and add knowledge cards — structured project and personal domain knowledge (.neox/knowledge/)',
    group: 'agent',
    tier: 'primary',
    keywords: ['knowledge', 'kb', 'docs', 'reference', 'wiki', '知识', '文档', '资料'],
    builtin: true,
    toolNames: ['knowledge_search', 'knowledge_add'],
};

/* Deep Research —— 多角度并行调研 + 证据账本。
 * 只放 deep_research 一个入口: research_record 是 worker 专用的, 由 deep_research 经
 * extraToolsForType 注入给子 agent, **不能进主 agent 的工具树** (主 agent 手上没有账本
 * slug, 给了它只会乱记)。 */
export const researchPack: ToolPack = {
    id: 'research',
    label: '深度调研',
    icon: '◇',
    description: 'Multi-angle web research with parallel workers and an evidence ledger: every conclusion carries a verbatim quote checked against the archived page, and disagreeing sources are kept side by side instead of silently resolved. For comparisons, selection decisions and prior-art surveys — not for a single fact one web_search can settle.',
    group: 'web',
    tier: 'primary',
    keywords: ['research', 'deep research', 'survey', 'investigate', 'compare', 'prior art', 'evidence', 'citation',
               '调研', '深度调研', '研究', '竞品', '选型', '对比', '综述', '资料', '取证'],
    builtin: true,
    /* 各模式都提供 research 命令；调研能力不限定在编码场景。 */
    toolNames: ['deep_research'],
};

// ==================== Primary: Scheduling & Tasks ====================

export const schedulingPack: ToolPack = {
    id: 'scheduling',
    label: '定时调度',
    icon: '⏰',
    description: 'Create, delete and list cron jobs, plus self-wakeup for waiting on long-running work',
    group: 'agent',
    tier: 'primary',
    keywords: ['cron', 'schedule', 'timer', 'periodic', 'recurring', 'wakeup', 'wait'],
    builtin: true,
    modes: ['work', 'code'], /* Life 用 schedule_reminder 就够, cron/wakeup 是 dev/长任务 */
    toolNames: ['cron_create', 'cron_delete', 'cron_list', 'schedule_wakeup'],
};

export const taskManagementPack: ToolPack = {
    id: 'task_management',
    label: '任务管理',
    icon: '☐',
    description: 'Create, query, update, list and stop tasks — tracking progress through multi-step work',
    group: 'agent',
    tier: 'primary',
    keywords: ['task', 'todo', 'progress', 'track', 'checklist'],
    builtin: true,
    modes: ['work', 'code'],
    toolNames: ['task_create', 'task_get', 'task_update', 'task_list', 'task_stop', 'task_output'],
};

export const lifePack: ToolPack = {
    id: 'life',
    label: '提醒与天气',
    icon: '⏰',
    description: 'Schedule reminders that actually fire (schedule_reminder / list_pending_tasks), fetch real weather (get_weather, Open-Meteo), and remember the user\'s preferences (update_profile).',
    group: 'agent',
    tier: 'primary',
    keywords: [
      'remind', 'reminder', 'schedule', 'notify', 'notification', 'alarm', 'alert',
      'every day', 'every week', 'anniversary', 'birthday',
      'weather', 'forecast', 'temperature', 'rain', 'umbrella',
      'profile', 'preference', 'about me',
      '档案', '画像', '记住我', '偏好',
      '提醒', '定时', '通知', '闹钟', '每天', '每周', '纪念日', '生日',
      '天气', '温度', '下雨', '预报', '带伞',
    ],
    builtin: true,
    modes: ['work'],
    toolNames: ['schedule_reminder', 'list_pending_tasks', 'get_weather', 'update_profile'],
};

/* macOS 桥 — 助手的本机权力: 系统日历/提醒事项/联系人/iMessage.
 * AppleScript 直驱, 零第三方 API 零 key, 跟 iPhone/Watch 走 iCloud 同步。
 * 非 darwin 平台工具实例是空数组 (macosBridgeTools.ts IS_MAC gate),
 * pack 仍注册但 tool_search 解析不到实例 = 自然不可见。 */
export const macosBridgePack: ToolPack = {
    id: 'macos_bridge',
    label: 'macOS 系统桥',
    icon: '⌘',
    description: 'System calendar read/write / reminders (list/add/complete, synced with iPhone) / contact lookup / send iMessage. ' +
                 'AppleScript 直驱本机应用, 首次调用触发 macOS 自动化授权。',
    group: 'platform',
    tier: 'primary',
    keywords: [
      'calendar', 'event', 'schedule', 'meeting', 'appointment', 'agenda', 'free', 'busy',
      'reminders', 'todo', 'contacts', 'phone', 'email', 'birthday', 'imessage', 'message', 'text',
      '日历', '日程', '安排', '会议', '预约', '提醒事项', '联系人', '电话', '生日', '短信', '发消息',
    ],
    builtin: true,
    modes: ['work'],
    toolNames: ['calendar_events', 'calendar_add', 'apple_reminders', 'contacts_search', 'send_imessage'],
};

export const planModePack: ToolPack = {
    id: 'plan_mode',
    label: '计划模式',
    icon: '⏸',
    description: 'Enter and exit plan mode: preview the execution plan and only act after the user approves',
    group: 'agent',
    tier: 'primary',
    keywords: ['plan', 'approve', 'review', 'preview'],
    builtin: true,
    modes: ['work', 'code'],
    toolNames: ['enter_plan_mode', 'exit_plan_mode'],
};

export const worktreePack: ToolPack = {
    id: 'worktree',
    label: 'Git Worktree',
    icon: '⎇',
    description: 'Create and exit an isolated git worktree, so changes can be tried safely',
    group: 'vcs',
    tier: 'primary',
    keywords: ['worktree', 'isolate', 'branch', 'experiment', 'sandbox'],
    builtin: true,
    modes: ['code'],
    toolNames: ['enter_worktree', 'exit_worktree'],
};

// ==================== Primary: Surface 右栏画布 ====================

/* open_surface 已升为 always-active (vibe IDE 主反馈通道, 跟 edit/write 同级),
 * 这个 pack 只装"开了之后的细操作"4 个 — 模型主动需要更新/关 surface 时再 tool_search 解锁. */
export const surfacePack: ToolPack = {
    id: 'surface',
    label: '右栏画布',
    icon: '◧',
    description: 'Manage already-open surfaces — update content / close / edit a plan / tick a todo. open_surface is the always-available entry point; these are the follow-up operations.',
    group: 'core',
    tier: 'primary',
    keywords: ['surface', 'panel', 'preview', 'render', 'show', 'display',
               'markdown', 'mermaid', 'diagram', 'image', 'html', 'web',
               'plan', 'todo', 'todos', 'checklist'],
    builtin: true,
    modes: ['work', 'code'], /* Life 用 chat 卡片, 不管理 surface panel */
    toolNames: ['update_surface', 'close_surface', 'edit_plan', 'update_todos'],
};

/* Target Mission 工具按需解锁；tool_search('target') 加载完整工作流，随后由 call_tool
 * 驱动检查和继续操作。 */
export const targetModePack: ToolPack = {
    id: 'target_mode',
    label: '长期目标',
    icon: '◎',
    description: 'Autonomous long-running missions: set an objective (activate_target) / break out a research plan (plan_target) / self-check completeness' +
                 '(check_target_done) / 暂停·继续·放弃。适合"你自己把 X 从头做完"这类多轮自主任务。',
    group: 'agent',
    tier: 'primary',
    keywords: ['target', 'mission', 'goal', 'autonomous', 'long-running', 'self-driving', 'objective',
               '目标', '长期', '自主', '长跑', '任务目标', '自己完成', '一直做'],
    builtin: true,
    modes: ['work', 'code'],
    toolNames: [
        'activate_target', 'plan_target', 'plan_block', 'check_target_done',
        'abandon_target', 'pause_target', 'continue_target',
    ],
};

/* AI 生图和改图是场景化能力，通过 tool_search('生图'/'image') 解锁。 */
export const imageGenPack: ToolPack = {
    id: 'image_gen',
    label: 'AI 生图',
    icon: '◐',
    description: 'Text-to-image (generate_image) and image-to-image editing (edit_image). Multiple providers (Gemini/OpenRouter/...), ' +
                 '出图落盘并推右栏 surface 预览。',
    group: 'data',
    tier: 'primary',
    keywords: ['image', 'generate', 'picture', 'photo', 'draw', 'edit image', 'inpaint',
               '生图', '画图', '文生图', '图生图', '改图', '配图', '出图', '图片',
               /* PPT 场景的词也放进来 —— 做 deck 时配图是常规动作,
                * 但生图工具属于 image_gen pack, agent 不搜就看不到它。
                * (试过把 generate_image 直接写进 pptxPack.toolNames: 那违反了
                *  "一个工具只属于一个 pack" 的不变量, strict 模式下主进程直接抛异常
                *  起不来 —— 跨 pack 复用只能靠关键词命中, 不能靠重复声明所有权。) */
               'ppt', 'pptx', 'slides', 'deck', '幻灯片', '演示', '封面', '配图', '章节图'],
    builtin: true,
    modes: ['work'],
    toolNames: ['generate_image', 'edit_image'],
};

/* PPTX 生成通过 tool_search('ppt'/'slides') 解锁。 */
export const pptxPack: ToolPack = {
    id: 'pptx',
    label: 'PPT 幻灯片',
    icon: '▤',
    description: 'Generate .pptx presentations page by page with a live preview (deck_begin → deck_add_slide → deck_export; ' +
                 'any length) or in one shot for ≤5 pages (create_slides), and list templates (list_slide_templates). ' +
                 'Read an existing .pptx slide by slide (pptx_read) and replace text in place keeping layout/fonts/images ' +
                 '(pptx_replace_text) — use these to edit the user\'s own deck instead of regenerating it. ' +
                 '自研引擎, 声明式布局 + 主题 + 真可编辑表格。',
    group: 'data',
    tier: 'primary',
    keywords: ['ppt', 'pptx', 'slides', 'presentation', 'deck', 'keynote',
               '幻灯片', '演示', '演示文稿', '课件', '汇报', 'ppt 生成'],
    builtin: true,
    modes: ['work', 'code'],
        toolNames: ['deck_begin', 'deck_add_slide', 'deck_export', 'create_slides', 'list_slide_templates', 'pptx_read', 'pptx_replace_text'],
};

// ==================== Extended Packs (特定场景) ====================

export const debugPack: ToolPack = {
    id: 'debug',
    label: '通用调试',
    icon: '▪',
    description: 'Breakpoint management, debug sessions, variable inspection and stepping (Electron desktop)',
    group: 'devops',
    tier: 'extended',
    keywords: ['debug', 'breakpoint', 'step', 'variable', 'stack', 'trace', 'evaluate'],
    builtin: true,
    modes: ['code'],
    toolNames: [
        'set_breakpoint', 'remove_breakpoint',
        'list_breakpoints', 'clear_breakpoints',
        'start_debug_session', 'stop_debug_session',
        'debug_continue', 'debug_step_over',
        'debug_step_into', 'debug_step_out',
        'get_variables', 'get_stack_trace',
        'evaluate_expression',
    ],
};

export const javaDebugPack: ToolPack = {
    id: 'java_debug',
    label: 'Java 调试',
    icon: '▪',
    description: 'Java remote debugging: launch/attach a process, breakpoints, stepping, variables, evaluation',
    group: 'devops',
    tier: 'extended',
    keywords: ['java', 'jvm', 'debug', 'jdwp', 'attach', 'remote'],
    builtin: true,
    modes: ['code'],
    toolNames: [
        'java_debug_launch', 'java_debug_attach',
        'java_debug_set_breakpoint',
        'java_debug_continue', 'java_debug_step_over',
        'java_debug_step_into', 'java_debug_step_out',
        'java_debug_get_variables', 'java_debug_get_stack_trace',
        'java_debug_evaluate', 'java_debug_stop',
    ],
};

export const terminalPack: ToolPack = {
    id: 'terminal',
    label: '终端管理',
    icon: '▪',
    description: 'Create, destroy and run terminal sessions (Electron desktop)',
    group: 'devops',
    tier: 'extended',
    keywords: ['terminal', 'pty', 'session', 'console'],
    builtin: true,
    modes: ['code'],
    toolNames: [
        'terminal_execute', 'terminal_create', 'terminal_destroy',
    ],
};

export const neoxConfigPack: ToolPack = {
    id: 'neox_config',
    label: 'Neox 配置管理',
    icon: '○',
    description: 'Neox configuration: unified queries and change proposals (neox_config), providers, models, MCP, TTS, language, health checks and diagnostics',
    group: 'platform',
    tier: 'extended',
    keywords: ['config', 'provider', 'model', 'mcp', 'settings', 'health', 'diagnose', 'orchestration', 'routing'],
    builtin: true,
    version: '2.1',
    modes: ['work', 'code'], /* Life 用户不改 Neox 配置 */
    toolNames: [
        /* 统一配置面 (Team P1 能力1): get/list 直读 + propose_set 提案确认 */
        'neox_config',
        'read_neox_config', 'write_neox_config',
        'list_neox_providers', 'add_neox_provider',
        'set_default_neox_provider', 'remove_neox_provider',
        'neox_switch_model', 'neox_list_models',
        'neox_mcp_manage', 'neox_health_check',
        'neox_export_config', 'neox_diagnose',
    ],
};

// ==================== 导出 ====================

export const BUILTIN_PACKS: ToolPack[] = [
    // Primary
    fileOpsPack,
    codeSearchPack,
    codeIntelPack,
    scriptExecPack,
    executePack,
    qualityPack,
    gitPack,
    webPack,
    browserPack,
    computerPack,
    sheetPack,
    wordPack,
    agentPack,
    teamPack,
    systemPack,
    memoryPack,
    knowledgePack,
    researchPack,
    schedulingPack,
    taskManagementPack,
    lifePack,
    macosBridgePack,
    planModePack,
    worktreePack,
    surfacePack,
    targetModePack,
    imageGenPack,
    pptxPack,
    // Extended
    debugPack,
    javaDebugPack,
    terminalPack,
    neoxConfigPack,
];
