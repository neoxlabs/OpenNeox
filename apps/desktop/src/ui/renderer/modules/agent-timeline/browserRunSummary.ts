
type StepLike = {
  action?: unknown;
  args?: Record<string, unknown>;
  label?: unknown;
  do?: unknown;
};

const clip = (v: unknown, n: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** URL 只留站点 + 路径, 查询串不进主行 */
function shortUrl(u: unknown): string {
  const s = String(u ?? '');
  try {
    const url = new URL(s);
    if (url.protocol === 'file:') return decodeURIComponent(url.pathname.split('/').pop() || s);
    return clip(`${url.host}${url.pathname === '/' ? '' : url.pathname}`, 48);
  } catch {
    return clip(s, 48);
  }
}

function target(a: Record<string, unknown>): string {
  return clip(a.text ?? a.name ?? a.label ?? a.selector ?? a.ref ?? '', 24);
}

const VERB_ZH: Record<string, string> = {
  navigate: '打开', click: '点击', type: '输入', fill_form: '填写表单', press_key: '按键', scroll: '滚动',
  hover: '悬停', select_option: '选择', wait_for: '等待', wait_for_navigation: '等页面跳转', expect: '检查',
  eval: '在页面里运行脚本', get_text: '读取页面文字', query: '查找页面元素', screenshot: '截图',
  get_aria_tree: '读取页面结构', back: '后退', forward: '前进', reload: '刷新', get_console_logs: '看控制台',
  get_network: '看网络请求', get_bbox: '量元素位置', sync_daily_logins: '同步登录状态', choose: '作答', repeat: '批量重复',
};
const VERB_EN: Record<string, string> = {
  navigate: 'Open', click: 'Click', type: 'Type', fill_form: 'Fill form', press_key: 'Press', scroll: 'Scroll',
  hover: 'Hover', select_option: 'Select', wait_for: 'Wait', wait_for_navigation: 'Wait for navigation', expect: 'Check',
  eval: 'Run script in page', get_text: 'Read text', query: 'Find elements', screenshot: 'Screenshot',
  get_aria_tree: 'Read page structure', back: 'Back', forward: 'Forward', reload: 'Reload', get_console_logs: 'Console',
  get_network: 'Network', get_bbox: 'Measure', sync_daily_logins: 'Sync logins', choose: 'Answer', repeat: 'Repeat',
};

export function describeBrowserStep(step: StepLike, isZh: boolean): string {
  const action = String(step?.action ?? '');
  const a = (step?.args ?? {}) as Record<string, unknown>;
  const verb = (isZh ? VERB_ZH : VERB_EN)[action] ?? action;
  if (typeof step?.label === 'string' && step.label.trim()) return clip(step.label, 40);
  switch (action) {
    case 'navigate':
      return `${verb} ${shortUrl(a.url)}`;
    case 'type': {
      const what = clip(a.text ?? a.value ?? '', 20);
      const where = target({ ...a, text: undefined });
      return isZh ? `${where ? `在「${where}」` : ''}输入「${what}」` : `Type "${what}"${where ? ` into ${where}` : ''}`;
    }
    case 'fill_form': {
      const n = Array.isArray(a.fields) ? a.fields.length : Object.keys((a.fields as object) ?? {}).length;
      return isZh ? `${verb}（${n} 项）` : `${verb} (${n} fields)`;
    }
    case 'press_key':
      return `${verb} ${clip(a.key ?? '', 16)}`;
    case 'repeat':
      return verb;
    default: {
      const t = target(a);
      return t && ['click', 'hover', 'select_option', 'wait_for', 'expect', 'choose'].includes(action)
        ? (isZh ? `${verb}「${t}」` : `${verb} "${t}"`)
        : verb;
    }
  }
}

export function summarizeBrowserRun(
  args: Record<string, unknown> | null | undefined,
  isZh: boolean,
  maxInline = 4,
): { line: string; steps: string[] } {
  const raw = Array.isArray((args ?? {}).steps) ? ((args as { steps: StepLike[] }).steps) : [];
  const steps = raw.map((s) => describeBrowserStep(s, isZh));
  const shown = steps.slice(0, maxInline).join(' → ');
  const rest = steps.length - maxInline;
  const tail = rest > 0 ? (isZh ? ` … 共 ${steps.length} 步` : ` … ${steps.length} steps`) : '';
  return { line: shown ? `${shown}${tail}` : '', steps };
}

/** 没有专门翻译的工具: 不甩 JSON, 摊成「键 值 · 键 值」, 只取标量, 每项截短 */
export function summarizeGenericArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    parts.push(`${k} ${clip(v, 40)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(' · ');
}
