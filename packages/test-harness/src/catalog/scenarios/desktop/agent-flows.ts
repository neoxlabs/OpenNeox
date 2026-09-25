import type { Scenario } from '../../../types.js';

/**
 * Desktop agent + timeline journey flows.
 * Focus: multi-turn dialogue, tools, approval, compact, session isolation,
 * and timeline **component / layout** contracts (order, shimmer, gaps, align).
 */
export const agentFlows: Scenario[] = [
  {
    id: 'desktop.flow.agent-multi-tool-turn',
    module: 'desktop.agent-flow',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '完整一轮：提问 → 多工具 → 流式总结 → idle',
    why: '主对话路径。timeline 组件乱序/shimmer 死/composer 状态不同源 = 严重 bug',
    mode: 'manual',
    estimateMin: 12,
    combo: ['dialogue', 'tools', 'timeline', 'composer', 'streaming'],
    preconditions: [
      'Desktop 已开 workspace',
      'BYOK 或 OAuth 模型可用',
      '审批模式允许自动跑只读工具（或准备 Approve）',
      '新会话；记下 composer ctx badge',
    ],
    mustNot: [
      '工具间隙 Actions 头空白或死静态（应 shimmer）',
      '工具卡顺序与真实执行颠倒',
      '流式气泡整段闪烁重置丢字',
      'turn 结束后 composer 仍显示「工具执行中」',
      'timeline 最后一行被 composer/approve-dock 遮挡',
    ],
    codeHint: 'ActivityRow showShimmer+turnActive; TimelineComposer; mapTimeline',
    steps: [
      {
        phase: 'D0 · layout baseline',
        action: '空会话看 timeline 列：feed / composer / 侧栏',
        expect: 'composer 与 timeline 卡片左右外缘对齐；无浮层遮最后一行',
        severity: 'blocker',
        assertUi: [
          {
            type: 'geometry',
            rule: 'composer.__box 外缘 ≈ timeline 卡片外缘（宽窗口下）',
            note: 'agent-timeline.css 明确要求 px-perfect 对齐',
          },
          {
            type: 'geometry',
            rule: 'feed 可滚到底，最后一条消息完整可见，不被 composer 挡住',
          },
        ],
      },
      {
        phase: 'D1 · send',
        action: '发：「先读 README（或指定文件），再 grep 一个关键词，最后用中文总结三点」',
        expect: 'user 气泡出现在 feed 底；composer 进入 running；Stop 可见',
        severity: 'blocker',
        assertUi: [
          { type: 'visible', target: 'user message bubble' },
          { type: 'visible', target: 'Stop / interrupt control' },
          { type: 'state', target: 'composer', state: 'running' },
        ],
      },
      {
        phase: 'D2 · activity head',
        action: '首个工具出现时看 Actions/Activity 头',
        expect: '有可读标题；running 时 shimmer；子工具行缩进层级清晰',
        severity: 'blocker',
        assertUi: [
          { type: 'state', target: '.atl-activity head', state: 'shimmer while running' },
          { type: 'geometry', rule: 'activity 头与子 tool 行垂直间距稳定，不重叠' },
          { type: 'class', target: 'activity', has: ['is-running or shimmer class'], note: '非 awaiting' },
        ],
      },
      {
        phase: 'D3 · tool gap thinking',
        action: '观察 tool_result 完成后、下一工具开始前的间隙（1–5s）',
        expect: 'Actions 头仍 shimmer（turnActive）；composer 仍显示进行中',
        severity: 'blocker',
        assertUi: [
          {
            type: 'state',
            target: 'activity head',
            state: 'shimmer ON during inter-tool thinking gap',
            note: '2026-07-14 回归：只看 hasRunningChild 会灭 shimmer',
          },
          { type: 'state', target: 'composer status', state: 'still busy / tokens ticking' },
        ],
      },
      {
        phase: 'D4 · tool order',
        action: '两个工具都完成后看时间线',
        expect: 'read → grep（或实际顺序）自上而下；无重复同 toolCallId 卡',
        severity: 'blocker',
        assertUi: [
          { type: 'order', sequence: ['user', 'tool A', 'tool B', 'assistant stream'] },
          { type: 'not_visible', target: 'duplicate tool cards same id' },
        ],
      },
      {
        phase: 'D5 · stream',
        action: '盯助手流式总结',
        expect: '文字追加流畅；滚动贴底；上滚时不强制拽回（或有回到底部）',
        severity: 'major',
        assertUi: [
          { type: 'geometry', rule: '流式时气泡宽度与其它助手气泡一致，不左右跳动' },
        ],
      },
      {
        phase: 'D6 · settle',
        action: 'turn 结束后检查',
        expect: 'shimmer 停；composer idle；ctx badge 更新；可立即再输入',
        severity: 'blocker',
        assertUi: [
          { type: 'state', target: 'composer', state: 'idle' },
          { type: 'state', target: 'activity head', state: 'no shimmer' },
          { type: 'geometry', rule: '最后一条助手内容完整露出在 composer 上方' },
        ],
      },
    ],
  },

  {
    id: 'desktop.flow.approval-queue-then-continue',
    module: 'desktop.agent-flow',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: 'Manual 审批：等待 UI → Approve → 继续 → Deny 路径',
    why: '审批空白头 / banner 不消失 / 队列卡死 = 阻断写操作',
    mode: 'manual',
    estimateMin: 12,
    combo: ['approval', 'timeline', 'composer', 'shell'],
    preconditions: [
      '将该 session 设为 manual / 需批 shell 或写文件',
      'agent mode 允许提危险工具',
    ],
    mustNot: [
      '等待审批时 Actions 头空白（transparent shimmer）',
      'Approve 后 banner 不立刻消失',
      'Deny 后工具仍 running',
      'approve-dock 与 timeline 卡片宽度不对齐/遮挡',
    ],
    codeHint: 'ActivityRow isAwaitingApproval; answerApproval; atl-approve-dock',
    steps: [
      {
        phase: 'A1 · trigger',
        action: '发：「必须用 shell 执行 `echo APPROVAL_FLOW`，不要跳过」',
        expect: '出现审批 banner/dock；timeline 进入 awaiting',
        severity: 'blocker',
        assertUi: [
          { type: 'visible', target: 'approve dock / banner' },
          {
            type: 'geometry',
            rule: 'approve-dock 卡片外缘与 composer 外缘对齐（同 padding 公式）',
          },
        ],
      },
      {
        phase: 'A2 · awaiting head',
        action: '看 Activity/工具标题（不要只看 banner）',
        expect: '标题/命令固态可读；badge is-awaiting；无空白 shimmer 头',
        severity: 'blocker',
        assertUi: [
          {
            type: 'class',
            target: 'activity row',
            has: ['is-awaiting'],
            missing: ['blank shimmer-only head'],
            note: 'isAwaitingApproval 时应固态 summary，禁止 brief 透明字',
          },
          { type: 'text', target: 'tool title', matches: 'echo|shell|命令可见' },
          { type: 'state', target: 'tool badge', state: 'is-awaiting amber' },
        ],
      },
      {
        phase: 'A3 · approve',
        action: '点 Approve（先不 Remember）',
        expect: 'banner 瞬时消失；工具变 running→done；出现 APPROVAL_FLOW；turn 继续完',
        severity: 'blocker',
        assertUi: [
          { type: 'not_visible', target: 'approve banner', note: '立刻，不是等下一事件才清' },
          { type: 'state', target: 'tool', state: 'running then done' },
        ],
      },
      {
        phase: 'A4 · deny path',
        action: '再发需批命令，点 Deny',
        expect: '工具取消/失败态；composer 可输入；无永久 awaiting banner',
        severity: 'blocker',
        assertUi: [
          { type: 'not_visible', target: 'stuck approve banner' },
          { type: 'state', target: 'composer', state: 'idle' },
        ],
      },
      {
        phase: 'A5 · remember (optional)',
        action: '再触发一次，Approve+Remember，再触发同类',
        expect: '行为符合产品策略（跳过或仍拦），但 UI 不得卡死',
        severity: 'major',
      },
    ],
  },

  {
    id: 'desktop.flow.compact-badge-popup-continue',
    module: 'desktop.agent-flow',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '长会话压缩：卡片 + composer badge + context popup 三联一致后继续聊',
    why: '三处数字不一致会让用户以为压缩没发生',
    mode: 'manual',
    estimateMin: 15,
    combo: ['compact', 'tokens', 'composer', 'timeline', 'dialogue'],
    preconditions: ['能把 context 抬到可触发压缩，或手动触发压缩入口'],
    mustNot: [
      'timeline 显示 xx→yy 但 badge 仍是旧高值',
      'Context popup 与 badge 串 session 或串旧值',
      '压缩后无法续聊',
    ],
    codeHint: 'useStreamHandler handleContextCompaction; ContextDetailPopup',
    steps: [
      {
        phase: 'K1 · inflate',
        action: '多轮工具/长回复抬高 ctx，记录 badge 与 popup',
        expect: 'badge 上升',
        severity: 'major',
      },
      {
        phase: 'K2 · compact UI',
        action: '触发压缩，观察 timeline 压缩卡',
        expect: '进度/结果卡可见；文案无双 Compact；位置在正确 turn 内',
        severity: 'blocker',
        assertUi: [
          { type: 'visible', target: 'context_compaction card' },
          { type: 'geometry', rule: '压缩卡宽度与其它 timeline 卡一致，不溢出 panel' },
          { type: 'not_visible', target: 'Compact Compact double label' },
        ],
      },
      {
        phase: 'K3 · dials',
        action: '压缩完成后对比 badge 与打开 Context popup',
        expect: '两者 ≈ finalTokens；cache 区合理清零/刷新',
        severity: 'blocker',
        assertUi: [
          { type: 'state', target: 'composer ctx badge', state: 'dropped to finalTokens' },
          { type: 'order', sequence: ['badge value', 'popup used value'], note: '数值一致' },
        ],
      },
      {
        phase: 'K4 · continue',
        action: '续问压缩前主题',
        expect: '可答；badge 从新基线涨；无孤儿 running 压缩卡',
        severity: 'blocker',
      },
    ],
  },

  {
    id: 'desktop.flow.session-switch-mid-stream',
    module: 'desktop.agent-flow',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: 'A 流式中切到 B → 回 A：内容/ctx/running 不串',
    why: '串会话是最高优先级数据错乱',
    mode: 'manual',
    estimateMin: 10,
    combo: ['session', 'streaming', 'tokens', 'timeline'],
    mustNot: [
      'B 出现 A 的 delta',
      '回 A 后丢失半截或重复整段',
      'badge 显示成另一 session 的 ctx',
      '停在错误 session 的永久 running',
    ],
    steps: [
      {
        phase: 'X1 · A stream',
        action: '会话 A 发长文任务，确认流式开始',
        expect: 'A feed 在涨',
        severity: 'major',
      },
      {
        phase: 'X2 · switch B',
        action: '中途切到会话 B（空或旧）',
        expect: 'B 独立；composer/badge 属 B；A 的流不写进 B',
        severity: 'blocker',
        assertUi: [
          { type: 'not_visible', target: "A's streaming text inside B feed" },
          { type: 'state', target: 'composer badge', state: "matches B's context" },
        ],
      },
      {
        phase: 'X3 · back A',
        action: '回 A；必要时 Stop',
        expect: 'A 内容连续可懂；无 B 消息；停止后可新发',
        severity: 'blocker',
      },
      {
        phase: 'X4 · interrupt orphan',
        action: 'A 再开长任务，Stop/Esc',
        expect: '无永久 running 孤儿卡；Actions shimmer 停',
        severity: 'blocker',
        assertUi: [
          { type: 'not_visible', target: 'stuck is-running activity' },
          { type: 'state', target: 'composer', state: 'idle' },
        ],
      },
    ],
  },

  {
    id: 'desktop.flow.byok-fail-then-oauth-or-fix',
    module: 'desktop.agent-flow',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '坏 BYOK 发送失败 → 设置修复/换模 → 同 UI 恢复对话',
    why: '设置与对话之间的往返最易白屏/锁死',
    mode: 'manual',
    estimateMin: 10,
    combo: ['byok', 'settings', 'composer', 'error', 'dialogue'],
    mustNot: [
      '错误后无限 thinking',
      '打开设置再回来 timeline 空白',
      'BrowserView/覆盖层闪白挡住设置',
    ],
    steps: [
      {
        phase: 'P1 · fail',
        action: '用坏 key 发消息',
        expect: 'error_classified 可见；composer 解锁',
        severity: 'blocker',
        assertUi: [
          { type: 'visible', target: 'classified error UI' },
          { type: 'state', target: 'composer', state: 'editable' },
        ],
      },
      {
        phase: 'P2 · settings roundtrip',
        action: '打开 Settings→Providers，改 key 或换模型，关掉设置回会话',
        expect: 'timeline 仍在；无白屏；surface suppress 无闪白',
        severity: 'blocker',
        assertUi: [
          { type: 'geometry', rule: '设置层打开时主 timeline 不错位崩布局' },
          { type: 'not_visible', target: 'full-window white flash' },
        ],
      },
      {
        phase: 'P3 · recover',
        action: '发「只回复 DESK_OK」',
        expect: '助手回复 DESK_OK；错误历史仍在上方可区分',
        severity: 'blocker',
        assertUi: [
          { type: 'order', sequence: ['error', 'new user', 'assistant DESK_OK'] },
        ],
      },
    ],
  },

  {
    id: 'desktop.flow.edit-diff-review-continue',
    module: 'desktop.agent-flow',
    surface: 'desktop',
    tier: 'core',
    priority: 'P1',
    kind: 'flow',
    title: '改文件 → EditDiff 卡 → Review → 再问确认',
    why: 'diff 卡布局错/按钮无效会毁掉改码信任',
    mode: 'manual',
    estimateMin: 10,
    combo: ['diff', 'timeline', 'surface', 'dialogue'],
    mustNot: [
      'diff 卡溢出或挡住 composer',
      'Revert/Review 点了无反应',
      'Review 打开的内容与卡内 diff 不一致',
    ],
    steps: [
      {
        phase: 'F1 · edit',
        action: '要求最小改动某文件一行',
        expect: '出现 EditDiff 卡，增删行可读',
        severity: 'blocker',
        assertUi: [
          { type: 'visible', target: 'EditDiffCard' },
          { type: 'geometry', rule: 'diff 卡在 feed 内，不与 composer 重叠' },
        ],
      },
      {
        phase: 'F2 · review',
        action: '点 Review/打开文件',
        expect: 'surface/编辑器内容与 diff 一致',
        severity: 'blocker',
      },
      {
        phase: 'F3 · ask',
        action: '回 timeline 问「你改了哪一行」',
        expect: '回答与 diff 一致；布局仍对齐',
        severity: 'major',
      },
    ],
  },
];
