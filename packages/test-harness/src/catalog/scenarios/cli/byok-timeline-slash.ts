import type { Scenario } from '../../../types.js';

export const byok: Scenario[] = [
  {
    id: 'cli.byok.provider-setup',
    module: 'cli.byok',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: '无 key 时引导 / provider add 可用',
    why: 'BYOK 是日常入口',
    mode: 'manual',
    codeHint: 'providerSetupFlow',
    steps: [
      { action: '无可用 provider 时发消息', expect: '明确引导而非静默挂起' },
      { action: '按引导 add provider + key', expect: '下一轮可对话' },
    ],
  },
  {
    id: 'cli.byok.bad-key',
    module: 'cli.byok',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: '坏 key 有分类错误，可继续改配置',
    why: '401/连接错误要可读',
    mode: 'manual',
    steps: [
      { action: '配置错误 API key 发消息', expect: 'error 分类清晰（auth/network）' },
      { action: '改回正确 key', expect: '无需重启 CLI 即可恢复（或提示重启一次）' },
    ],
  },
  {
    id: 'cli.byok.model-switch',
    module: 'cli.byok',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: 'model 列表与切换',
    why: '切模后会话仍可用',
    mode: 'manual',
    steps: [
      { action: 'model ls / 选模', expect: '列表含已配置 BYOK 模型' },
      { action: '切换后短问答', expect: '回复来自新模型，StatusLine 一致' },
    ],
  },
  {
    id: 'cli.byok.base-url',
    module: 'cli.byok',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: '自定义 baseURL 死链报错可读',
    why: '中转站配置常见',
    mode: 'manual',
    steps: [
      { action: 'baseURL 指到不可达地址', expect: '超时/连接错误，非无限 Thinking' },
    ],
  },
];

export const timeline: Scenario[] = [
  {
    id: 'cli.timeline.user-assistant-order',
    module: 'cli.timeline',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: '用户/助手消息时间线顺序正确',
    why: '基础可读性',
    mode: 'manual',
    steps: [
      { action: '连续 3 轮问答', expect: '从上到下时间序正确，无错位覆盖' },
    ],
  },
  {
    id: 'cli.timeline.tool-card-collapse',
    module: 'cli.timeline',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: '长工具输出可折叠/截断，不淹没终端',
    why: '大 JSON 刷屏',
    mode: 'manual',
    steps: [
      { action: '触发大输出工具（读大文件）', expect: '卡片截断或可滚动，输入区仍可用' },
    ],
  },
  {
    id: 'cli.timeline.info-vs-error',
    module: 'cli.timeline',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: 'info / error / compact 卡片视觉可区分',
    why: '系统消息与助手回复混淆',
    mode: 'manual',
    steps: [
      { action: '制造一次错误 + 一次 /compact', expect: '卡片类型一眼可分' },
    ],
  },
];

export const slash: Scenario[] = [
  {
    id: 'cli.slash.help',
    module: 'cli.slash',
    surface: 'cli',
    tier: 'smoke',
    priority: 'P1',
    title: '/help 列出常用命令',
    why: '新人入口',
    mode: 'manual',
    steps: [
      { action: '输入 /help', expect: '列出 compact/model/clear 等，无 crash' },
    ],
  },
  {
    id: 'cli.slash.clear',
    module: 'cli.slash',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: '/clear 或等价清屏后 ctx 与画面重置',
    why: '清会话残留',
    mode: 'manual',
    steps: [
      { action: '多轮后执行 clear', expect: 'timeline 清空或新会话，ctx 下降' },
    ],
  },
  {
    id: 'cli.slash.unknown',
    module: 'cli.slash',
    surface: 'cli',
    tier: 'core',
    priority: 'P2',
    title: '未知 slash 友好提示',
    why: '拼写错误体验',
    mode: 'manual',
    steps: [
      { action: '输入 /compacx', expect: '提示未知命令或相近建议，不当普通 prompt 乱发' },
    ],
  },
  {
    id: 'cli.slash.compact-alias',
    module: 'cli.slash',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: '/compact 可触发压缩流程',
    why: '主 slash 路径',
    mode: 'manual',
    steps: [
      { action: '输入 /compact', expect: '进入压缩流程或给出无需压缩反馈' },
    ],
  },
];
