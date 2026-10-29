
import type { StepContent } from './types';

const BROWSER_TOOLS = new Set(['browser_run', 'browser_replay']);

export function isBrowserRunTool(toolKey: string): boolean {
  return BROWSER_TOOLS.has(toolKey.toLowerCase());
}

/** 跟 computerRunSummary 同一套词 —— 同一个动作在审批卡和结果卡上不该有两种说法。 */
const ACTION_ZH: Record<string, string> = {
  navigate: '打开', click: '点击', type: '输入', fill_form: '填表', press_key: '按键',
  scroll: '滚动', hover: '悬停', select_option: '选择', wait_for: '等待',
  wait_for_navigation: '等跳转', expect: '断言', eval: '执行脚本',
  get_text: '读文本', query: '查元素', screenshot: '截图', get_aria_tree: '读页面结构',
  back: '后退', forward: '前进', reload: '刷新',
};
const ACTION_EN: Record<string, string> = {
  navigate: 'Open', click: 'Click', type: 'Type', fill_form: 'Fill', press_key: 'Key',
  scroll: 'Scroll', hover: 'Hover', select_option: 'Select', wait_for: 'Wait',
  wait_for_navigation: 'Wait for nav', expect: 'Expect', eval: 'Run script',
  get_text: 'Read text', query: 'Query', screenshot: 'Screenshot', get_aria_tree: 'Read page',
  back: 'Back', forward: 'Forward', reload: 'Reload',
};

function clip(s: unknown, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 网址只留域名 + 短路径 —— 完整 URL 在卡片上又长又没人读 */
function shortUrl(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const path = u.pathname === '/' ? '' : u.pathname;
    return clip(u.hostname + path, 40);
  } catch {
    return clip(s, 40);
  }
}

/** 单步 → 一句话。 */
export function describeBrowserStep(raw: unknown, isZh: boolean): string {
  const s = (raw ?? {}) as Record<string, unknown>;
  const action = String(s.action ?? '').trim();
  const verb = (isZh ? ACTION_ZH[action] : ACTION_EN[action]) ?? (action || (isZh ? '操作' : 'Act'));
  const a = (s.args ?? {}) as Record<string, unknown>;
  const label = clip(s.label, 24);

  if (action === 'navigate') {
    const u = shortUrl(a.url);
    return u ? `${verb} ${u}` : verb;
  }
  if (action === 'type' || action === 'fill_form') {
    const text = clip(a.text ?? a.value, 20);
    const where = clip(a.selector ?? a.name ?? label, 20);
    if (text && where) return isZh ? `${verb}到「${where}」「${text}」` : `${verb} "${text}" into ${where}`;
    if (text) return isZh ? `${verb}「${text}」` : `${verb} "${text}"`;
  }
  if (action === 'press_key') return `${verb} ${clip(a.key, 20)}`;
  if (action === 'eval') {
    /* 执行的代码本身要露出来 —— 这一步是这张卡上最该被看见的东西 */
    const code = clip(a.expression ?? a.script ?? a.code, 40);
    return code ? (isZh ? `${verb}: ${code}` : `${verb}: ${code}`) : verb;
  }
  const target = clip(label || a.selector || a.text || a.name, 24);
  return target ? (isZh ? `${verb}「${target}」` : `${verb} "${target}"`) : verb;
}

/** 步骤失败原因只留第一句 —— 完整那段是写给模型的诊断书 (跟 computer 卡同一条口径)。 */
export function shortBrowserError(raw: string): string {
  const first = String(raw).split(/[。\n]/)[0]?.trim() ?? '';
  const s = first || String(raw).trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

const TITLE_ARG_CLIP = 200;

/** 工具行标题。返回 undefined = 不是浏览器脚本工具, 调用方走自己的分支。 */
export function browserToolTitle(
  toolKey: string,
  args: Record<string, unknown> | undefined,
  isZh: boolean,
): string | undefined {
  const key = toolKey.toLowerCase();
  if (key === 'browser_replay') {
    const name = clip(args?.name, 30);
    if (!name) return isZh ? '列出录好的操作' : 'List recorded scripts';
    return isZh ? `复跑录好的操作「${name}」` : `Replay "${name}"`;
  }
  if (key !== 'browser_run') return undefined;

  const steps = Array.isArray(args?.steps) ? args!.steps as unknown[] : [];
  const firstNav = steps.find((s) => (s as { action?: string })?.action === 'navigate');
  const site = firstNav ? shortUrl(((firstNav as { args?: Record<string, unknown> }).args ?? {}).url) : '';
  const head = site
    ? (isZh ? `操作 ${site}` : `Drive ${site}`)
    : (isZh ? '操作网页' : 'Drive page');
  const detail = steps.slice(0, 4).map((s) => describeBrowserStep(s, isZh)).join(' → ')
    + (steps.length > 4 ? (isZh ? ` … (${steps.length} 步)` : ` … (${steps.length} steps)`) : '');
  if (!detail.trim()) return head;
  const clipped = detail.length > TITLE_ARG_CLIP ? `${detail.slice(0, TITLE_ARG_CLIP - 1)}…` : detail;
  return `${head} · ${clipped}`;
}

export function browserCardContent(
  metadata: Record<string, unknown> | undefined,
  isZh: boolean,
): StepContent | undefined {
  const md = (metadata ?? {}).browser as Record<string, unknown> | undefined;
  if (!md) return undefined;

  const rawSteps = Array.isArray(md.steps) ? md.steps : [];
  const steps = rawSteps.map((raw) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    return {
      text: describeBrowserStep(s, isZh),
      ok: typeof s.ok === 'boolean' ? s.ok : undefined,
      ms: typeof s.ms === 'number' ? s.ms : undefined,
      error: typeof s.error === 'string' ? shortBrowserError(s.error) : undefined,
      /* 自愈过的步骤要标出来 —— "页面结构变了"这件事本身值钱 */
      note: typeof s.healed === 'string' ? (isZh ? '定位失效, 已自愈' : 'selector healed') : undefined,
    };
  });

  const screenshot = typeof md.screenshot === 'string' ? md.screenshot : undefined;
  if (steps.length === 0 && !screenshot) return undefined;

  const site = typeof md.site === 'string' ? md.site : '';
  const recorded = typeof md.recorded === 'string' ? md.recorded : undefined;
  const note = recorded
    ? (isZh ? `已录成可复跑的「${recorded}」` : `Recorded as "${recorded}"`)
    : (typeof md.title === 'string' && md.title ? clip(md.title, 60) : undefined);

  return {
    type: 'browser',
    site: site || undefined,
    url: typeof md.url === 'string' ? md.url : undefined,
    steps,
    screenshot,
    totalMs: typeof md.totalMs === 'number' ? md.totalMs : undefined,
    note,
    signals: {
      consoleErrors: typeof md.consoleErrors === 'number' ? md.consoleErrors : undefined,
      failedRequests: typeof md.failedRequests === 'number' ? md.failedRequests : undefined,
      apiCalls: typeof md.apiCalls === 'number' ? md.apiCalls : undefined,
    },
  } as StepContent;
}
