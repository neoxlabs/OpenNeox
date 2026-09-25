import type { Scenario } from '../../../types.js';

/**
 * CLI agent journey flows — multi-turn, multi-system combinations.
 * These are the quality gate; atoms are helpers only.
 */
export const agentFlows: Scenario[] = [
  {
    id: 'cli.flow.agent-read-summarize-edit',
    module: 'cli.agent-flow',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '多轮 Agent：读文件 → 总结 → 小改 → 再确认',
    why: '用户主路径。任一步 timeline/StatusLine 错乱即严重体验事故',
    mode: 'manual',
    estimateMin: 12,
    combo: ['dialogue', 'tools', 'timeline', 'statusline', 'streaming'],
    preconditions: [
      'CLI 已配置可用 BYOK 模型',
      'workspace 含可读源码文件',
      '新开会话，记录初始 ctx',
    ],
    mustNot: [
      '工具卡盖住输入区或 StatusLine 换行撑破',
      '助手气泡重复整段 / 乱序插到用户消息上方',
      'turn 结束后仍卡 Thinking/Writing',
      'ctx 数字跳变到压缩前或负数',
    ],
    codeHint: 'Ink timeline + StatusLine + tool cards',
    steps: [
      {
        phase: 'T0 · baseline',
        action: '记录 StatusLine：model / ctx / busy 态',
        expect: 'idle；ctx 为会话基线；模型名正确',
        severity: 'major',
        assertUi: [
          { type: 'state', target: 'StatusLine', state: 'idle' },
          { type: 'geometry', rule: 'StatusLine 单行，不与输入区重叠' },
        ],
      },
      {
        phase: 'T1 · read',
        action: '发：「用工具读 <某文件>，只引用关键片段，先别改」',
        expect: '出现 read/工具卡 → 再出现助手总结；顺序上→下正确',
        severity: 'blocker',
        assertUi: [
          { type: 'order', sequence: ['user prompt', 'tool card(read)', 'assistant summary'] },
          { type: 'state', target: 'tool card', state: 'running then done' },
          { type: 'geometry', rule: '工具卡缩进/宽度与助手气泡层级可区分，不贴边重叠' },
        ],
      },
      {
        phase: 'T1 · status',
        action: '工具运行中观察 StatusLine',
        expect: 'busy 文案合理（Reading/Running）；结束后回 idle',
        severity: 'blocker',
        assertUi: [
          { type: 'state', target: 'StatusLine', state: 'busy→idle' },
        ],
      },
      {
        phase: 'T2 · follow-up',
        action: '发：「上面那个文件的核心风险再列 3 条」',
        expect: '新 user 气泡在上一轮下方；回复承接上下文，不重读整文件除非需要',
        severity: 'blocker',
        assertUi: [
          { type: 'order', sequence: ['T1 assistant', 'T2 user', 'T2 assistant'] },
        ],
      },
      {
        phase: 'T3 · edit',
        action: '发：「只改一处注释/日志，最小 diff」',
        expect: '出现 edit/write 卡；完成后有可读 diff 摘要；无二次幽灵写卡',
        severity: 'blocker',
        assertUi: [
          { type: 'order', sequence: ['user', 'edit tool', 'assistant confirm'] },
          { type: 'not_visible', target: 'duplicate edit cards for same path' },
        ],
      },
      {
        phase: 'T4 · verify',
        action: '发：「确认刚才改了哪一行」',
        expect: '回答与真实 diff 一致；StatusLine idle；ctx 单调合理上升',
        severity: 'major',
      },
    ],
  },

  {
    id: 'cli.flow.explore-parallel-interrupt-resume',
    module: 'cli.agent-flow',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '并行 Explore → Esc 中断 → 新消息续作',
    why: 'Explore+中断是高频组合；sticky agents / 幽灵卡是严重 bug',
    mode: 'manual',
    estimateMin: 10,
    combo: ['explore', 'interrupt', 'timeline', 'statusline'],
    preconditions: ['模型可用', '新会话'],
    mustNot: [
      'Esc 后底部仍显示 N agents>0',
      'Explore 卡永久 running',
      'Enter 只排队不中断',
      '中断后再开 Explore 建不出卡',
    ],
    codeHint: 'abortRunningTaskAgents + runningTaskInput + taskAgentsSuspended',
    steps: [
      {
        phase: 'E1 · spawn',
        action: '发：「并行开 2 个 Explore 查 <主题 A> 和 <主题 B>，先别总结」',
        expect: '底部 N agents≥2；sidebar/卡可见；主 timeline 有 Explore 相关节点',
        severity: 'blocker',
        assertUi: [
          { type: 'visible', target: 'N agents ≥ 2' },
          { type: 'state', target: 'Explore cards', state: 'running' },
        ],
      },
      {
        phase: 'E2 · mid-flight UI',
        action: '观察 5–10s（勿输入）',
        expect: '主 StatusLine busy；Explore 卡有进度/标题，不空白',
        severity: 'major',
        assertUi: [
          { type: 'geometry', rule: 'Explore 卡不遮挡输入框；与主 timeline 间距稳定' },
        ],
      },
      {
        phase: 'E3 · Esc',
        action: '按 Esc 中断',
        expect: '全部 Explore 收尾；N→0；无 interrupt 提示残留',
        severity: 'blocker',
        assertUi: [
          { type: 'text', target: 'agents badge', matches: '0|hidden' },
          { type: 'state', target: 'StatusLine', state: 'idle' },
          { type: 'not_visible', target: 'Enter to interrupt' },
        ],
      },
      {
        phase: 'E4 · Enter-interrupt contract',
        action: '再开 Explore，运行中输入「停」并 Enter（不要 Esc）',
        expect: '立即中断并作为新 turn，不是静默排队',
        severity: 'blocker',
      },
      {
        phase: 'E5 · resume',
        action: '发：「用一句话总结刚才中断前你看到了什么」',
        expect: '可正常回复；可再开 Explore；无 suspended 死锁',
        severity: 'blocker',
      },
    ],
  },

  {
    id: 'cli.flow.long-ctx-compact-continue',
    module: 'cli.agent-flow',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '长对话撑 ctx → /compact → 续问仍连贯 + ctx 表盘正确',
    why: '压缩后 ctx 不降 / 双前缀 / 卡 busy = 严重误导',
    mode: 'manual',
    estimateMin: 15,
    combo: ['compact', 'tokens', 'cache', 'dialogue', 'statusline'],
    preconditions: ['能把 ctx 抬到 ≥15K（多轮大工具输出）'],
    mustNot: [
      '卡片显示已压缩但 StatusLine ctx 仍停在高位',
      'Compact Compact / 压缩 压缩 双前缀',
      '无需压缩后仍 spinner + interrupt 提示',
      '压缩后下一问答非所问 / 失忆到不可用',
    ],
    codeHint: 'context_compaction → setTokenStats; compactProgress',
    steps: [
      {
        phase: 'C1 · inflate',
        action: '多轮让 agent 读大文件/贴长输出，直到 ctx 明显高于基线',
        expect: 'StatusLine ctx 上升；c-r 若存在语义自洽',
        severity: 'major',
        assertUi: [
          { type: 'state', target: 'StatusLine ctx', state: 'monotone up vs baseline' },
        ],
      },
      {
        phase: 'C2 · compact',
        action: '执行 /compact，盯 StatusLine + timeline 卡',
        expect: '有生成摘要进度（非秒关 snip）；单前缀；卡片 xxK→yyK',
        severity: 'blocker',
        assertUi: [
          { type: 'text', target: 'StatusLine compact label', matches: '单次 压缩|Compact + 进度条' },
          { type: 'not_visible', target: 'Compact Compact' },
          { type: 'order', sequence: ['compact progress', 'compact result card'] },
        ],
      },
      {
        phase: 'C3 · ctx dial',
        action: '压缩结束后立刻读 StatusLine ctx / c-r',
        expect: 'ctx≈finalTokens；cache 计数清零或合理刷新；busy 已清',
        severity: 'blocker',
        assertUi: [
          { type: 'state', target: 'StatusLine', state: 'idle' },
          { type: 'geometry', rule: 'token 区不换行重叠' },
        ],
      },
      {
        phase: 'C4 · continue',
        action: '发：「压缩前我们在讨论什么？下一步建议？」',
        expect: '能接上主题（允许摘要级）；新 ctx 从低位再涨',
        severity: 'blocker',
      },
      {
        phase: 'C5 · noop path',
        action: '短会话或刚压完再 /compact',
        expect: '无需压缩/未获收益时 StatusLine 不残留 busy',
        severity: 'blocker',
      },
    ],
  },

  {
    id: 'cli.flow.shell-fail-recover-stream',
    module: 'cli.agent-flow',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: 'Shell 成功→失败→再成功 + 流式回复不乱序',
    why: '失败码不可见 / 后台卡重复 / 流式插乱是严重工具信任问题',
    mode: 'manual',
    estimateMin: 10,
    combo: ['shell', 'streaming', 'timeline', 'error'],
    mustNot: [
      'exit≠0 显示成成功',
      '同一后台命令刷多张重复卡',
      '失败后卡死 busy 无法再输入',
    ],
    steps: [
      {
        phase: 'S1 · ok',
        action: '要求执行 `echo FLOW_OK`',
        expect: '一张 shell 卡；输出含 FLOW_OK；成功态',
        severity: 'blocker',
        assertUi: [
          { type: 'order', sequence: ['user', 'shell card', 'assistant'] },
          { type: 'state', target: 'shell card', state: 'success' },
        ],
      },
      {
        phase: 'S2 · fail',
        action: '要求执行 `exit 1` 或 `false`，并解释退出码',
        expect: '卡片标明失败/非零；助手解释；可继续输入',
        severity: 'blocker',
        assertUi: [
          { type: 'state', target: 'shell card', state: 'failed' },
          { type: 'state', target: 'StatusLine', state: 'idle after' },
        ],
      },
      {
        phase: 'S3 · bg',
        action: '要求后台 `sleep 8 && echo BG_DONE`（若 CLI 支持 bg）',
        expect: '单卡状态流转 running→done；不复制插卡',
        severity: 'major',
        assertUi: [
          { type: 'not_visible', target: 'duplicate bg shell cards' },
        ],
      },
      {
        phase: 'S4 · stream',
        action: '要求「用 15 行诗总结刚才三次 shell」',
        expect: '流式连续追加；结束后无重复段落；与 shell 卡时间序正确',
        severity: 'blocker',
        assertUi: [
          { type: 'order', sequence: ['S1 card', 'S2 card', 'S3 card?', 'poem stream'] },
        ],
      },
    ],
  },

  {
    id: 'cli.flow.byok-bad-key-recover',
    module: 'cli.agent-flow',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '坏 key 对话失败 → 改配置 → 同会话恢复成功',
    why: '静默挂起 / 无法恢复 = 阻断用户',
    mode: 'manual',
    estimateMin: 8,
    combo: ['byok', 'error', 'dialogue'],
    mustNot: [
      '坏 key 无限 Thinking',
      '改对 key 后仍必须强杀进程才能用',
      '错误卡片与助手气泡样式无法区分',
    ],
    steps: [
      {
        phase: 'B1 · break',
        action: '换成明显错误的 API key，发「你好」',
        expect: '分类错误（auth/network）；StatusLine 回 idle',
        severity: 'blocker',
        assertUi: [
          { type: 'visible', target: 'error / classified error card' },
          { type: 'state', target: 'StatusLine', state: 'idle' },
        ],
      },
      {
        phase: 'B2 · fix',
        action: '改回正确 key（slash 或配置流程）',
        expect: '配置生效提示或可立即再试',
        severity: 'major',
      },
      {
        phase: 'B3 · recover',
        action: '同一会话再发「只回复 RECOVERED」',
        expect: '正常助手回复含 RECOVERED；timeline 保留错误历史在上方',
        severity: 'blocker',
        assertUi: [
          { type: 'order', sequence: ['error card', 'new user', 'assistant RECOVERED'] },
        ],
      },
    ],
  },

  {
    id: 'cli.flow.stream-interrupt-clean-next',
    module: 'cli.agent-flow',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '长流式中途 Esc → 下一轮短答干净',
    why: '半截 stream 污染下一轮是严重渲染/状态 bug',
    mode: 'manual',
    estimateMin: 6,
    combo: ['streaming', 'interrupt', 'statusline'],
    mustNot: [
      '下一轮混入上一轮残片',
      'Esc 后永久 Writing',
      '输入区被半截气泡顶乱',
    ],
    steps: [
      {
        phase: 'I1 · stream',
        action: '发「写一首很长的诗，至少 80 行，慢慢写」',
        expect: '流式刷出；StatusLine Writing/Thinking',
        severity: 'major',
      },
      {
        phase: 'I2 · Esc',
        action: '输出到一半 Esc',
        expect: '立即停；半截保留为中断态或截断气泡；idle',
        severity: 'blocker',
        assertUi: [
          { type: 'state', target: 'StatusLine', state: 'idle' },
          { type: 'geometry', rule: '截断气泡不与输入区重叠' },
        ],
      },
      {
        phase: 'I3 · clean',
        action: '发「只回复 PONG」',
        expect: '完整短答 PONG；无诗句残片混入',
        severity: 'blocker',
      },
    ],
  },
];
