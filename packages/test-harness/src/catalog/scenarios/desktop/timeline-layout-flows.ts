import type { Scenario } from '../../../types.js';

/**
 * Desktop timeline **layout / component** journeys.
 * These are not "is X visible" smoke — they chain visual contracts users feel:
 * alignment, gaps, overlap, shimmer vs solid, scroll, dock stacking.
 */
export const timelineLayoutFlows: Scenario[] = [
  {
    id: 'desktop.flow.timeline-align-composer-dock',
    module: 'desktop.timeline-layout',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '宽/窄窗口：timeline 卡 · composer · approve-dock 外缘对齐',
    why: '不对齐会像廉价拼凑；历史 bug：padding shorthand 冲掉自适应',
    mode: 'manual',
    estimateMin: 8,
    combo: ['timeline', 'composer', 'approval', 'layout'],
    preconditions: ['有至少一条助手消息；能触发一次审批更好'],
    mustNot: [
      '宽窗口下 composer 比 timeline 卡窄一截或冲出右边',
      'approve-dock 与 composer 左右错位',
      '缩小窗口后横向 padding 消失贴边',
    ],
    codeHint: 'agent-timeline.css .atl-composer / .atl-approve-dock / .atl-row-clamp',
    steps: [
      {
        phase: 'L1 · wide',
        action: '窗口拉到 ≥1200px 宽，对比 timeline 卡片与 composer 盒子左右外缘',
        expect: '外缘对齐（目测 ≤2px）',
        severity: 'blocker',
        assertUi: [
          {
            type: 'geometry',
            rule: 'timeline card left/right == composer.__box left/right',
          },
        ],
      },
      {
        phase: 'L2 · narrow',
        action: '缩到 ≈480–640px 宽（侧栏仍开）',
        expect: 'composer 跟 panel 收缩；不出现横向双重滚动条撕布局',
        severity: 'blocker',
        assertUi: [
          {
            type: 'geometry',
            rule: 'composer padding-inline 仍在；内容不贴死边',
            note: '禁止 shorthand 覆盖响应式横向 padding',
          },
        ],
      },
      {
        phase: 'L3 · dock',
        action: '若有审批 banner，对比 dock 与 composer 外缘',
        expect: '同款对齐；banner 不挡 feed 最后一行到不可读',
        severity: 'major',
        assertUi: [
          {
            type: 'geometry',
            rule: 'approve-dock margin-inline 与 composer 同公式',
          },
        ],
      },
      {
        phase: 'L4 · empty focus',
        action: '新空会话看 empty-focus 布局',
        expect: '标题与 composer 左缘对齐；垂直居中不飘',
        severity: 'major',
        assertUi: [
          {
            type: 'geometry',
            rule: 'empty-focus 标题左缘 == composer 输入文字左缘',
          },
        ],
      },
    ],
  },

  {
    id: 'desktop.flow.timeline-scroll-overlap-stack',
    module: 'desktop.timeline-layout',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '长 feed 滚动：贴底、上读、z-index（slash/@ 不被挡）',
    why: '最后一行被挡 / popover 被吞 = 严重可用性',
    mode: 'manual',
    estimateMin: 8,
    combo: ['timeline', 'composer', 'scroll', 'layout'],
    mustNot: [
      'TurnSummaryBar/composer 浮到 feed 上挡住最后消息',
      'slash 菜单被 backdrop-filter 挡住点不到',
      '上滚阅读时强制拽回底导致无法看历史',
    ],
    codeHint: 'agent-timeline grid rows; composer z-index:10',
    steps: [
      {
        phase: 'R1 · long feed',
        action: '造 ≥15 条消息的会话，滚到最底',
        expect: '最后一条完整可见，位于 composer 上方清晰间距',
        severity: 'blocker',
        assertUi: [
          {
            type: 'geometry',
            rule: 'last feed item bottom < composer top（有间隙，无重叠）',
          },
        ],
      },
      {
        phase: 'R2 · stick',
        action: '再发一条流式长回复，保持在底部',
        expect: '自动跟随；间距保持',
        severity: 'major',
      },
      {
        phase: 'R3 · read up',
        action: '上滚到较早消息停留 5s（流式仍可进行或刚结束）',
        expect: '不被强制拉回；或出现「回到底部」且可点',
        severity: 'blocker',
      },
      {
        phase: 'R4 · slash z',
        action: '在 composer 输入 `/` 打开 slash 菜单',
        expect: '菜单完整可见可点，不被上方 bg tasks / filter 挡住',
        severity: 'blocker',
        assertUi: [
          {
            type: 'geometry',
            rule: 'slash popover 在 composer stacking context 之上',
          },
        ],
      },
    ],
  },

  {
    id: 'desktop.flow.timeline-shimmer-vs-awaiting',
    module: 'desktop.timeline-layout',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    kind: 'flow',
    title: '同一会话内对比：running shimmer ↔ awaiting 固态标题',
    why: '两种状态搞混会「以为卡死」或「以为没在等你」',
    mode: 'manual',
    estimateMin: 10,
    combo: ['timeline', 'approval', 'shimmer', 'layout'],
    preconditions: ['能先后触发普通工具 running 与 manual 审批'],
    mustNot: [
      'awaiting 时头空白',
      'running 间隙 shimmer 灭但 composer 仍 busy',
      '两种状态视觉无法区分',
    ],
    codeHint: 'showShimmer = !isAwaitingApproval && (hasRunningChild || turnActive)',
    steps: [
      {
        phase: 'H1 · running',
        action: '触发只读长工具（或 sleep shell）',
        expect: '头/工具行 shimmer；标题仍能扫到或 brief 可见',
        severity: 'blocker',
        assertUi: [
          { type: 'state', target: 'activity/tool', state: 'shimmer running' },
          { type: 'class', target: 'tool row', has: ['running shimmer cues'] },
        ],
      },
      {
        phase: 'H2 · gap',
        action: '工具刚结束、模型还在想下一步时抓拍',
        expect: 'Activity 头仍 shimmer；与 composer busy 一致',
        severity: 'blocker',
      },
      {
        phase: 'H3 · awaiting',
        action: '触发需审批工具，对比同一 Activity 区域',
        expect: '切换为固态标题+ is-awaiting；shimmer 关闭',
        severity: 'blocker',
        assertUi: [
          { type: 'class', target: 'activity', has: ['is-awaiting'] },
          { type: 'state', target: 'head', state: 'solid readable title' },
          { type: 'not_visible', target: 'blank transparent shimmer head' },
        ],
      },
      {
        phase: 'H4 · after approve',
        action: 'Approve 后',
        expect: '回到 running shimmer 或快速完成；无样式卡在 awaiting',
        severity: 'blocker',
      },
    ],
  },

  {
    id: 'desktop.flow.timeline-nested-activity-spacing',
    module: 'desktop.timeline-layout',
    surface: 'desktop',
    tier: 'core',
    priority: 'P1',
    kind: 'flow',
    title: '嵌套 Activity：多工具子行间距、新鲜高亮、折叠',
    why: '挤成一团或跳动会让人无法扫读工具轨迹',
    mode: 'manual',
    estimateMin: 8,
    combo: ['timeline', 'tools', 'layout'],
    mustNot: [
      '子行重叠',
      '新子工具插入时整块猛烈跳动遮视线',
      '折叠后仍占用错误空白或点不到展开',
    ],
    steps: [
      {
        phase: 'N1 · multi children',
        action: '一轮内触发 ≥3 个工具',
        expect: '子行垂直节奏一致；head 与 children 层级缩进清楚',
        severity: 'major',
        assertUi: [
          {
            type: 'geometry',
            rule: 'child rows share consistent left gutter; gaps ≥ design min',
          },
        ],
      },
      {
        phase: 'N2 · fresh mark',
        action: '新工具刚插入时观察',
        expect: '可有短暂 fresh 高亮，随后消退，不永久闪',
        severity: 'minor',
      },
      {
        phase: 'N3 · collapse',
        action: '若支持折叠 Activity，折/开各一次',
        expect: '高度变化平滑；composer 不被顶飞出视口',
        severity: 'major',
        assertUi: [
          {
            type: 'geometry',
            rule: 'collapse 后 feed 滚动位置可理解，不跳到顶丢失上下文',
          },
        ],
      },
    ],
  },
];
