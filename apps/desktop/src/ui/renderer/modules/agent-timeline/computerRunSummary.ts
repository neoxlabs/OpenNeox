
export interface ComputerRunStepLike {
  action?: unknown;
  app?: unknown;
  target?: unknown;
  text?: unknown;
  key?: unknown;
  label?: unknown;
  dx?: unknown;
  dy?: unknown;
  dx2?: unknown;
  dy2?: unknown;
  occurrence?: unknown;
}

export interface ComputerRunSummary {
  /** 目标 App 名 (脚本级 app, 没有就是第一个 launch 步骤的 app) */
  app: string;
  /** 每一步一句话, 顺序同脚本 */
  steps: string[];
  /** 一行式: `App · 步骤1 → 步骤2 … (N 步)`, 给审批卡那一行用 */
  line: string;
}

const ACTION_ZH: Record<string, string> = {
  launch: '启动', click: '点击', click_at: '点击', hover: '悬停', double_click: '双击', drag: '拖动',
  type: '输入', key: '按键',
  scroll: '滚动', press: '按下', focus: '聚焦', set_value: '填入',
  show_menu: '右键', select_text: '选中',
  wait: '等待', snapshot: '看一眼界面',
};

const ACTION_EN: Record<string, string> = {
  launch: 'Launch', click: 'Click', click_at: 'Click', hover: 'Hover', double_click: 'Double-click', drag: 'Drag',
  type: 'Type', key: 'Key',
  scroll: 'Scroll', press: 'Press', focus: 'Focus', set_value: 'Set',
  show_menu: 'Right-click', select_text: 'Select',
  wait: 'Wait', snapshot: 'Look at screen',
};

export function formatComputerDuration(ms: number, isZh: boolean): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  }
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return isZh ? `${m}分${sec}秒` : `${m}m ${sec}s`;
}

function clip(s: unknown, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 单步 → 一句话。target 编号只在**完全没有别的线索**时才露出来 (人看不懂编号, 但空着更糟)。 */
export function describeComputerStep(
  raw: ComputerRunStepLike | null | undefined,
  isZh: boolean,
  /** 脚本级的 App 名 —— launch 步骤常常不带自己的 app, 靠它才不至于写成"启动 应用" */
  fallbackApp?: string,
): string {
  const s = (raw ?? {}) as ComputerRunStepLike;
  const action = String(s.action ?? '').trim();
  const verb = (isZh ? ACTION_ZH[action] : ACTION_EN[action]) ?? (action || (isZh ? '操作' : 'Act'));
  const label = clip(s.label, 24);

  switch (action) {
    case 'launch': {
      const app = clip(s.app, 24) || clip(fallbackApp, 24);
      return app ? `${verb} ${app}` : (isZh ? '启动应用' : 'Launch app');
    }
    case 'type':
    case 'set_value': {
      const text = clip(s.text, 24);
      const where = label ? (isZh ? `到「${label}」` : ` into "${label}"`) : '';
      return isZh ? `${verb}${where}「${text}」` : `${verb}${where} "${text}"`;
    }
    case 'key':
      return `${verb} ${clip(s.key, 24)}`;
    case 'select_text': {
      /* 不给 text 就是全选 —— 写"选中"两个字用户看不出选了什么, 得说清是整段 */
      const text = clip(s.text, 24);
      if (!text) return isZh ? '全选文本' : 'Select all text';
      const nth = Number(s.occurrence ?? 0);
      const which = nth > 1 ? (isZh ? `第 ${nth} 处` : ` (match ${nth})`) : '';
      return isZh ? `${verb}${which}「${text}」` : `${verb} "${text}"${which}`;
    }
    case 'wait':
      return verb;
    case 'snapshot':
      return verb;
    case 'scroll': {
      const dx = Number(s.dx);
      const dy = Number(s.dy);
      const ratio = Number.isFinite(dx) && Number.isFinite(dy)
        && dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1
        && s.target === undefined;
      if (ratio) return verb;
      const dir = dy === 0 ? '' : (dy > 0 ? (isZh ? '向下' : ' down') : (isZh ? '向上' : ' up'));
      return `${verb}${dir}`;
    }
    case 'drag':
      return verb;
    default:
      break;
  }

  if (label) return isZh ? `${verb}「${label}」` : `${verb} "${label}"`;
  if (s.target !== undefined) return isZh ? `${verb}第 ${String(s.target)} 个元素` : `${verb} element #${String(s.target)}`;
  return verb;
}

/** 展开层用的完整步骤清单 (不截断步数) */
export function describeComputerSteps(steps: unknown, isZh: boolean, fallbackApp?: string): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => describeComputerStep(s as ComputerRunStepLike, isZh, fallbackApp));
}

/**
 * @param maxInline 一行里最多摊开几步, 多的收成 "… (N 步)"。卡片是回执不是文档。
 */
export function summarizeComputerRun(
  args: Record<string, unknown> | null | undefined,
  isZh: boolean,
  maxInline = 5,
): ComputerRunSummary {
  const a = (args ?? {}) as { app?: unknown; steps?: unknown };
  const rawSteps = Array.isArray(a.steps) ? (a.steps as ComputerRunStepLike[]) : [];
  const app = clip(
    a.app ?? rawSteps.find((s) => s && typeof s === 'object' && s.app)?.app ?? '',
    28,
  );
  const steps = describeComputerSteps(rawSteps, isZh, app);

  const shown = steps.slice(0, maxInline).join(' → ');
  const rest = steps.length - maxInline;
  const tail = rest > 0 ? (isZh ? ` … 共 ${steps.length} 步` : ` … ${steps.length} steps`) : '';
  const body = shown ? `${shown}${tail}` : '';
  const line = [app, body].filter(Boolean).join(' · ');

  return { app, steps, line };
}
