import type { Scenario } from '../../../types.js';

export const statusline: Scenario[] = [
  {
    id: 'cli.statusline.writing-basename',
    module: 'cli.statusline',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: 'Writing 全路径不撑爆单行',
    why: '回归: 长路径换行撑破 StatusLine',
    mode: 'manual',
    codeHint: 'StatusLine normalize basename',
    steps: [
      { action: '让 agent write 很深路径文件', expect: 'StatusLine 只显示 basename' },
      { action: '看终端宽度', expect: '单行不换行、不顶飞输入区' },
    ],
  },
  {
    id: 'cli.statusline.tokens-layout',
    module: 'cli.statusline',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: 'in / out / ctx / c-r 布局稳定可读',
    why: '表盘是压缩/缓存问题的第一观测面',
    mode: 'manual',
    codeHint: 'tokenStatsAdapter',
    steps: [
      { action: '完成一轮含工具的对话', expect: 'StatusLine 出现 in/out/ctx（及有则 c-r）' },
      { action: '缩窄终端', expect: '数字截断优雅，不乱码重叠' },
    ],
  },
  {
    id: 'cli.statusline.model-name',
    module: 'cli.statusline',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: '当前模型名显示正确，切换后更新',
    why: 'BYOK 切模后 status 残留旧模型会误导',
    mode: 'manual',
    steps: [
      { action: '记录 StatusLine 模型', expect: '与当前选中一致' },
      { action: '切换模型后再发消息', expect: 'StatusLine 模型名更新' },
    ],
  },
  {
    id: 'cli.statusline.busy-idle',
    module: 'cli.statusline',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: 'busy→idle 切换干净',
    why: '卡在 Thinking/Writing 会误以为死锁',
    mode: 'manual',
    steps: [
      { action: '短问答跑完', expect: 'StatusLine 回到 idle/可输入态' },
      { action: '失败分类错误后', expect: 'busy 清掉，可继续输入' },
    ],
  },
];

export const streaming: Scenario[] = [
  {
    id: 'cli.streaming.delta-smooth',
    module: 'cli.streaming',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: '流式 delta 连续，无明显卡顿空洞',
    why: '体感速度/渲染',
    mode: 'manual',
    steps: [
      { action: '要一段 300+ 字回复', expect: '文字持续刷出，结束后无重复段落' },
    ],
  },
  {
    id: 'cli.streaming.tool-then-continue',
    module: 'cli.streaming',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: '工具调用后继续流式，timeline 顺序正确',
    why: '工具卡与文本交错乱序',
    mode: 'manual',
    steps: [
      { action: '要求先读文件再总结', expect: '先工具卡再总结文本，顺序与时间一致' },
    ],
  },
  {
    id: 'cli.streaming.reasoning-optional',
    module: 'cli.streaming',
    surface: 'cli',
    tier: 'core',
    priority: 'P2',
    title: '有 reasoning 的模型思考块可折叠/不刷屏',
    why: '思考流淹没主回复',
    mode: 'manual',
    steps: [
      { action: '用带 thinking 的模型提问', expect: '思考与正文区分清晰，可继续操作' },
    ],
  },
];

export const shell: Scenario[] = [
  {
    id: 'cli.shell.foreground-card',
    module: 'cli.shell',
    surface: 'cli',
    tier: 'core',
    priority: 'P0',
    title: '前台 shell 卡片：命令、退出码、输出摘要',
    why: '工具卡可读性',
    mode: 'manual',
    steps: [
      { action: '让 agent 跑 echo HELLO', expect: '卡片显示命令与 HELLO/成功态' },
    ],
  },
  {
    id: 'cli.shell.background-no-dup',
    module: 'cli.shell',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: '后台 bash 不乱序、不重复插卡',
    why: '回归: backgroundedShellKeys',
    mode: 'manual',
    codeHint: 'backgroundedShellKeys',
    steps: [
      { action: '跑 sleep 较长后台命令', expect: '一张卡更新状态，不刷多张重复' },
      { action: '结束后', expect: '终态正确，无幽灵 running' },
    ],
  },
  {
    id: 'cli.shell.fail-exit',
    module: 'cli.shell',
    surface: 'cli',
    tier: 'core',
    priority: 'P1',
    title: '非零退出码在卡片上可见',
    why: '失败被当成功会误导',
    mode: 'manual',
    steps: [
      { action: '让 agent 跑 false 或 exit 1', expect: '卡片标明失败/非零码' },
    ],
  },
];
