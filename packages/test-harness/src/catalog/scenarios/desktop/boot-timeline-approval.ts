import type { Scenario } from '../../../types.js';
import { screenshot, type CdpPage } from '../../../harness/cdp.js';

export const boot: Scenario[] = [
  {
    id: 'desktop.boot.neox-ready',
    module: 'desktop.boot',
    surface: 'desktop',
    tier: 'smoke',
    priority: 'P0',
    title: 'renderer + window.neox 就绪',
    why: '所有 CDP 前置',
    mode: 'cdp',
    codeHint: 'preload window.neox',
    steps: [
      { action: 'NEOX_CDP_PORT=41777 启动桌面', expect: 'CDP /json/version 可连' },
      { action: 'attach :5180 renderer', expect: 'window.neox.getAppInfo 可用' },
    ],
    async run(ctx) {
      const page = ctx.page as CdpPage | undefined;
      if (!page) return { ok: false, error: 'no page' };
      const info = await page.evaluate(async () => {
        const neox = (window as any).neox;
        if (!neox?.getAppInfo) return { hasNeox: false };
        try {
          return { hasNeox: true, app: await neox.getAppInfo() };
        } catch (e) {
          return { hasNeox: true, error: String(e) };
        }
      });
      await screenshot(page, ctx.outDir, 'boot');
      return { ok: !!info?.hasNeox, detail: info as Record<string, unknown> };
    },
  },
  {
    id: 'desktop.boot.workspace-set',
    module: 'desktop.boot',
    surface: 'desktop',
    tier: 'smoke',
    priority: 'P0',
    title: 'setWorkspace 后 agent bridge 可用',
    why: '无 workspace 时 IPC 报 agent server not ready',
    mode: 'cdp',
    steps: [
      { action: 'window.neox.setWorkspace(合法目录)', expect: '成功返回' },
      { action: 'createSession', expect: '拿到 sessionId' },
    ],
    async run(ctx) {
      const page = ctx.page as CdpPage | undefined;
      const ws = ctx.workspacePath;
      if (!page) return { ok: false, error: 'no page' };
      if (!ws) return { ok: false, error: 'set NEOX_WS or --workspace' };
      const out = await page.evaluate(async (workspacePath) => {
        const neox = (window as any).neox;
        await neox.setWorkspace(workspacePath);
        const models = await neox.getAvailableModels?.();
        const modelId = models?.[0]?.id;
        if (!modelId) return { ok: false, error: 'no models' };
        const sess = await neox.createSession(workspacePath, modelId, {
          name: `etest-boot-${Date.now()}`,
        });
        return { ok: !!sess?.id, sessionId: sess?.id, modelId };
      }, ws);
      return { ok: !!out?.ok, detail: out as Record<string, unknown>, error: (out as any)?.error };
    },
  },
  {
    id: 'desktop.boot.cold-start-ui',
    module: 'desktop.boot',
    surface: 'desktop',
    tier: 'core',
    priority: 'P1',
    title: '冷启动首屏：侧栏/composer/无白屏',
    why: '首屏体验',
    mode: 'manual',
    steps: [
      { action: '杀进程冷启动', expect: '几秒内可见壳，非长时间白屏' },
      { action: '看侧栏与主区', expect: '布局完整，可点新建会话' },
    ],
  },
];

export const timeline: Scenario[] = [
  {
    id: 'desktop.timeline.gap-shimmer',
    module: 'desktop.timeline',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    title: '工具间隙 Actions 头仍 shimmer',
    why: '回归: 工具之间头变死静态',
    mode: 'manual',
    codeHint: 'turnActive bridge',
    steps: [
      { action: '多工具 turn（读+搜+写）', expect: '工具间隙 Actions/思考头仍活' },
      { action: 'turn 结束', expect: 'shimmer 停止，终态标题正确' },
    ],
  },
  {
    id: 'desktop.timeline.long-shell-shimmer',
    module: 'desktop.timeline',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    title: '长 shell 全程 running shimmer',
    why: '长命令像卡死',
    mode: 'manual',
    codeHint: 'mapTimeline pending',
    steps: [
      { action: '跑 sleep 15s 或长构建', expect: '卡片全程 running 动画' },
      { action: '结束后', expect: '变为完成态，耗时合理' },
    ],
  },
  {
    id: 'desktop.timeline.stream-chunks',
    module: 'desktop.timeline',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    title: '助手流式气泡连续、无整段闪烁重置',
    why: '重渲染丢字/闪白',
    mode: 'manual',
    steps: [
      { action: '要长文回复', expect: '文字追加流畅，无从头重打闪烁' },
    ],
  },
  {
    id: 'desktop.timeline.scroll-stick',
    module: 'desktop.timeline',
    surface: 'desktop',
    tier: 'core',
    priority: 'P1',
    title: '流式时自动贴底；上滚查看时不强制拽回',
    why: '阅读旧消息被拽走',
    mode: 'manual',
    steps: [
      { action: '流式中保持在底部', expect: '自动跟随新内容' },
      { action: '上滚看历史', expect: '不被强制拉回底（或有「回到底部」按钮）' },
    ],
  },
  {
    id: 'desktop.timeline.tool-order',
    module: 'desktop.timeline',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    title: '工具卡与文本块时间序正确',
    why: '交错乱序难读',
    mode: 'manual',
    steps: [
      { action: '要求先工具后总结', expect: '时间线顺序与实际执行一致' },
    ],
  },
];

export const approval: Scenario[] = [
  {
    id: 'desktop.approval.title-solid',
    module: 'desktop.approval',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    title: '等待审批时标题固态可见',
    why: '回归: 空白 shimmer 头',
    mode: 'manual',
    codeHint: 'ActivityRow isAwaitingApproval',
    steps: [
      { action: '审批模式 manual，触发需批工具', expect: '标题/命令可读，非空 shimmer' },
    ],
  },
  {
    id: 'desktop.approval.approve-continue',
    module: 'desktop.approval',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    title: 'Approve 后 banner 立刻消失且工具继续',
    why: '点了没反应 / 队列卡住',
    mode: 'manual',
    codeHint: 'answerApproval → replyPermission',
    steps: [
      { action: '点 Approve', expect: 'banner 瞬时消失' },
      { action: '看 timeline', expect: '工具变为 running/完成，turn 继续' },
    ],
  },
  {
    id: 'desktop.approval.deny-stops',
    module: 'desktop.approval',
    surface: 'desktop',
    tier: 'core',
    priority: 'P0',
    title: 'Deny 后工具停止，可发下一轮',
    why: 'Deny 后僵尸 running',
    mode: 'manual',
    steps: [
      { action: '点 Deny', expect: '该工具失败/取消态' },
      { action: '发新消息', expect: '新 turn 正常' },
    ],
  },
  {
    id: 'desktop.approval.remember',
    module: 'desktop.approval',
    surface: 'desktop',
    tier: 'core',
    priority: 'P1',
    title: 'Approve + Remember 后同类不再拦',
    why: 'remember 范围错误会一直弹或永远不弹',
    mode: 'manual',
    steps: [
      { action: 'Approve + Remember 一次 shell', expect: '立即继续' },
      { action: '同会话再触发同类', expect: '按策略跳过或仍拦（与模式文档一致）' },
    ],
  },
  {
    id: 'desktop.approval.queue-multi',
    module: 'desktop.approval',
    surface: 'desktop',
    tier: 'nightly',
    priority: 'P1',
    title: '连续多个审批请求按队列处理',
    why: '只处理第一个或全丢',
    mode: 'manual',
    steps: [
      { action: '一次 turn 触发多个需批工具', expect: '逐个弹出或列表清晰' },
      { action: '全部处理完', expect: '无残留 banner' },
    ],
  },
];
