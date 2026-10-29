
import type { StepContent } from './types';
import { summarizeComputerRun, describeComputerStep } from './computerRunSummary';
import { absoluteToAssetUrl } from '../../../shared/assetUrlPath';

/**
 * 本地文件 → 渲染层能读的 URL。
 *
 * 图标和截图都是磁盘上的文件 (~/.neox/run/icons, ~/.neox/run/shots), 主进程的
 * neox-asset 协议放行了这两个目录。直接写 file:// 是读不到的 (Electron 的 CSP 挡着)。
 */
export function localFileUrl(path: string): string {
  return absoluteToAssetUrl(path);
}

/** 标题里参数段的截断长度 —— 跟 mapTimeline 的 TITLE_ARG_CLIP 同一口径 (200) */
const TITLE_ARG_CLIP = 200;

const COMPUTER_TOOLS = new Set(['computer_run', 'computer_snapshot', 'computer_check_access']);

export function isComputerTool(toolKey: string): boolean {
  return COMPUTER_TOOLS.has(toolKey.toLowerCase());
}

/**
 * 工具行的标题。返回 undefined = 不是 computer 工具, 调用方继续走它自己的分支。
 *
 * 标题给成「操作 QQ · 点击「发送」→ 输入「…」」—— 折叠头取 ` · ` 之前那段,
 * 于是显示「操作 QQ」而不是「执行 1 条命令」。
 */
export function computerToolTitle(
  toolKey: string,
  args: Record<string, unknown> | undefined,
  isZh: boolean,
): string | undefined {
  switch (toolKey.toLowerCase()) {
    case 'computer_run': {
      const { app, line } = summarizeComputerRun(args, isZh);
      const head = app
        ? (isZh ? `操作 ${app}` : `Drive ${app}`)
        : (isZh ? '操作电脑' : 'Drive computer');
      /* line 的头一段就是 app, 去掉免得「操作 QQ · QQ · 点击…」 */
      const detail = app && line.startsWith(`${app} · `) ? line.slice(app.length + 3) : line;
      if (!detail) return head;
      const clipped = detail.length > TITLE_ARG_CLIP ? `${detail.slice(0, TITLE_ARG_CLIP - 1)}…` : detail;
      return `${head} · ${clipped}`;
    }
    case 'computer_snapshot': {
      const app = typeof args?.app === 'string' ? args.app.trim() : '';
      if (app) return isZh ? `看一眼 ${app} 的界面` : `Look at ${app}`;
      return isZh ? '看一眼屏幕' : 'Look at screen';
    }
    case 'computer_check_access':
      return isZh ? '检查电脑操作权限' : 'Check computer access';
    default:
      return undefined;
  }
}

/**
 * 结果卡的数据。
 *
 * 工具侧 (computerToolDefs.ts) 把只给 UI 的东西挂在 ToolResult.metadata.computer 上:
 *   { app, icon(dataURL), steps:[{action,label,ok,ms,error}], screenshot, totalMs }
 * 模型看到的仍是原来那份 JSON (CONTEXTUAL 的 content 原样透传), 图标不进上下文。
 *
 * 步骤文案复用 describeComputerStep —— 审批卡上写的是"要点什么", 这里写的是"点了什么",
 * 同一套词, 不该两处各编一份。
 */
export function shortStepError(raw: string): string {
  const first = String(raw).split(/[。\n]/)[0]?.trim() ?? '';
  const s = first || String(raw).trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

export function computerCardContent(
  metadata: Record<string, unknown> | undefined,
  isZh: boolean,
): StepContent | undefined {
  const md = (metadata ?? {}).computer as Record<string, unknown> | undefined;
  if (!md) return undefined;
  const tool = md.kind === 'snapshot' ? 'computer_snapshot' : 'computer_run';

  const rawSteps = Array.isArray(md.steps) ? md.steps : [];
  const steps = rawSteps.map((raw) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    return {
      text: describeComputerStep(s, isZh, typeof md.app === 'string' ? md.app : undefined),
      ok: typeof s.ok === 'boolean' ? s.ok : undefined,
      ms: typeof s.ms === 'number' ? s.ms : undefined,
      error: typeof s.error === 'string' ? shortStepError(s.error) : undefined,
    };
  });

  /* 只看一眼时没有步骤 —— 那张卡说的是"看到了什么" */
  const screenshot = typeof md.screenshot === 'string' ? md.screenshot : undefined;
  if (steps.length === 0 && !screenshot && tool === 'computer_run') return undefined;
  if (tool === 'computer_snapshot' && !screenshot) return { type: 'none' };

  const note = tool === 'computer_snapshot'
    ? (md.axBlind
      ? (isZh
        ? '这个 App 自己绘制界面, 读不到元素 —— 只能看图操作'
        : 'This app draws its own UI: no element tree, driving it visually')
      : (isZh
        ? `读到 ${Number(md.elementCount ?? 0)} 个可交互元素`
        : `${Number(md.elementCount ?? 0)} actionable elements`))
    : undefined;

  return {
    type: 'computer',
    app: typeof md.app === 'string' ? md.app : undefined,
    /* iconPath = 磁盘上的 PNG (新); icon = dataURL (旧会话里存过的, 别让它们变成破图) */
    icon: typeof md.iconPath === 'string' ? localFileUrl(md.iconPath)
      : (typeof md.icon === 'string' ? md.icon : undefined),
    steps,
    screenshot,
    totalMs: typeof md.totalMs === 'number' ? md.totalMs : undefined,
    ok: steps.length > 0 ? !steps.some((s) => s.ok === false) : undefined,
    note,
  };
}
