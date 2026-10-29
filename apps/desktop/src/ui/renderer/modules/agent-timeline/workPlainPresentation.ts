
import type { StepContent } from './types';
import { cronToHuman } from './cronHuman';

/** 过程文件: 助理为了干活临时写的脚本, 不是交给用户的东西。 */
const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|ps1|bat|cmd|rb|pl|php|go|rs|java|sql)$/i;

const SHELL_TOOLS = new Set([
  'execute_shell', 'execute_bash', 'run_shell', 'run_command', 'bash', 'shell', 'exec',
  'bash_output', 'bash_kill', 'execute_python', 'powershell',
]);
const WRITE_TOOLS = new Set(['write_file', 'write', 'create_file']);
const EDIT_TOOLS = new Set(['edit', 'edit_file', 'multi_edit', 'apply_patch', 'str_replace']);
const READ_TOOLS = new Set(['read_file', 'readfile', 'read', 'smart_read', 'read_multiple_files']);
const FIND_TOOLS = new Set(['search', 'search_files', 'grep', 'glob', 'list_directory', 'ls', 'show_tree', 'tree']);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function baseName(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function clip(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function pathArg(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  return str(args.file_path) || str(args.path) || str(args.save_path) || str(args.file)
    || str(args.filename) || str(args.name) || str(args.output_path) || '';
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return clip(url, 32); }
}

/** 这个路径是助理的过程脚本吗 (不是交付物)。 */
export function isProcessScript(path: string): boolean {
  return SCRIPT_EXT.test(path);
}

/* ── 内部步骤 ─────────────────────────────────────────────────────────
 * 跑命令、写临时脚本、在文件夹里翻 —— 助理为了干活做的中间动作, 对老板没有信息量。
 * Work 模式展开步骤列表时不列它们 (连同「思考」), 只在末尾说一句「另有 N 个中间步骤」。
 *
 * 判断只能靠标题: 时间线上的 step 不带工具名。所以这些标题**只在这里定义一次**,
 * plainWorkTitle 生成它们、isPlainInternalTitle 认它们, 两边用同一组常量, 不会对不上。 */
const INTERNAL = {
  shell: ['处理中的一步', 'A processing step'],
  scriptWrite: ['准备处理步骤', 'Prepare a processing step'],
  scriptEdit: ['调整处理步骤', 'Adjust a processing step'],
  scriptRead: ['检查处理步骤', 'Check a processing step'],
  browse: ['翻看文件夹', 'Look through the folder'],
} as const;
const INTERNAL_PREFIX = ['在文件里找', 'Look through files for'] as const;
const INTERNAL_TITLES = new Set<string>(Object.values(INTERNAL).flat());

export function isPlainInternalTitle(title: string): boolean {
  const t = title.trim();
  return INTERNAL_TITLES.has(t) || INTERNAL_PREFIX.some((p) => t.startsWith(p));
}

/** 藏起来的内部步骤归哪一类 —— 一轮收尾那一行「幕后还做了」按类报数用 */
export function plainInternalKind(title: string): 'process' | 'browse' | undefined {
  const t = title.trim();
  const browse = [...INTERNAL.browse] as string[];
  if (browse.includes(t) || INTERNAL_PREFIX.some((p) => t.startsWith(p))) return 'browse';
  return INTERNAL_TITLES.has(t) ? 'process' : undefined;
}

/**
 * Work 模式下一步的白话标题。返回 undefined = 这个工具没有白话写法, 调用方走原来的标题。
 */
export function plainWorkTitle(
  toolKey: string,
  args: Record<string, unknown> | undefined,
  isZh: boolean,
): string | undefined {
  const file = baseName(pathArg(args));
  /* 文档 / 表格 / 演示稿标题里前面已经说了「文档」「表格」, 扩展名是重复的, 还把名字挤到被截断 */
  const doc = file.replace(/\.(docx?|xlsx?|xlsm|csv|pptx?|pdf)$/i, '');
  const q = (zh: string, en: string) => (isZh ? zh : en);
  const pick = (pair: readonly [string, string]) => (isZh ? pair[0] : pair[1]);
  const named = (zh: string, en: string, obj: string) =>
    (obj ? q(`${zh}「${clip(obj)}」`, `${en} "${clip(obj)}"`) : q(zh, en));

  if (toolKey === 'sheet_new_workbook') return named('新建表格', 'Create spreadsheet', doc);
  if (toolKey === 'sheet_write_range') return q('往表格里填数据', 'Fill in the spreadsheet');
  if (toolKey === 'sheet_set_cells') return named('修改表格', 'Update spreadsheet', doc);
  if (toolKey === 'sheet_get_range' || toolKey === 'sheet_describe') return named('核对表格', 'Check spreadsheet', doc);
  if (toolKey === 'sheet_export_file' || toolKey === 'sheet_export') return named('保存表格', 'Save spreadsheet', doc);

  /* 文档 */
  if (toolKey === 'word_create') return named('新建文档', 'Create document', doc);
  if (/^word_(insert|edit|delete|replace|format|set)_/.test(toolKey)) return named('修改文档', 'Edit document', doc);
  if (/^word_(get|describe)/.test(toolKey)) return named('查看文档', 'Review document', doc);
  if (toolKey === 'word_export') return named('保存文档', 'Save document', doc);
  if (toolKey === 'word_to_pdf') return named('转成 PDF', 'Convert to PDF', doc);

  /* 演示稿 */
  if (toolKey === 'deck_begin') return named('开始做演示稿', 'Start the slides', str(args?.title));
  if (toolKey === 'deck_add_slide') {
    /* 页标题在 slots.title 里 (deckTools: { index, slots }); 拿不到就报第几页 —— 进度卡里「做一页幻灯片 ×3」看不出做到哪 */
    const slots = (args?.slots && typeof args.slots === 'object') ? args.slots as Record<string, unknown> : undefined;
    const idx = typeof args?.index === 'number' ? args.index : undefined;
    const page = str(args?.title) || str(slots?.title) || str(slots?.heading)
      || (idx !== undefined ? q(`第 ${idx + 1} 页`, `page ${idx + 1}`) : '');
    return named('做一页幻灯片', 'Make a slide', page);
  }
  if (toolKey === 'deck_export' || toolKey === 'create_slides') return named('生成演示稿', 'Build the slides', doc);
  if (toolKey === 'list_slide_templates') return q('挑选版式', 'Pick a layout');

  /* 文件 —— 脚本是过程, 不报文件名 (报了也看不懂) */
  if (WRITE_TOOLS.has(toolKey)) {
    if (!file) return q('写文件', 'Write a file');
    return isProcessScript(file) ? pick(INTERNAL.scriptWrite) : named('写好', 'Wrote', file);
  }
  if (EDIT_TOOLS.has(toolKey)) {
    if (file && isProcessScript(file)) return pick(INTERNAL.scriptEdit);
    return named('修改', 'Edit', file);
  }
  if (READ_TOOLS.has(toolKey)) {
    if (file && isProcessScript(file)) return pick(INTERNAL.scriptRead);
    return named('查看', 'Read', file);
  }
  if (FIND_TOOLS.has(toolKey)) {
    const pattern = str(args?.pattern) || str(args?.query);
    return pattern && !/[*?\\^$|()[\]{}]/.test(pattern)
      ? named(INTERNAL_PREFIX[0], INTERNAL_PREFIX[1], pattern)
      : pick(INTERNAL.browse);
  }
  if (SHELL_TOOLS.has(toolKey)) return pick(INTERNAL.shell);

  /* 网络 */
  if (toolKey === 'web_search' || toolKey === 'websearch') return named('上网查', 'Search the web for', str(args?.query) || str(args?.q));
  if (toolKey === 'web_fetch' || toolKey === 'webfetch' || toolKey === 'fetch') {
    const url = str(args?.url);
    return url ? named('看网页', 'Read', hostOf(url)) : q('看网页', 'Read a page');
  }
  if (toolKey === 'deep_research') return named('深入调研', 'Research', str(args?.question) || str(args?.topic) || str(args?.query));

  /* 其它常见动作 */
  if (toolKey === 'open_surface' || toolKey === 'update_surface') {
    const what = str(args?.title) || baseName(str(args?.source)).replace(/\.[A-Za-z0-9]+$/, '');
    return what ? named('在右侧打开', 'Opened on the right', what) : q('在右侧打开给你看', 'Opened it on the right');
  }
  if (toolKey === 'generate_image' || toolKey === 'edit_image') return q('画图', 'Make an image');
  if (toolKey === 'update_plan' || toolKey === 'set_plan' || toolKey === 'update_todos') return q('理一下步骤', 'Plan the steps');
  if (toolKey === 'ask_user') return q('问你一下', 'Ask you');
  if (toolKey === 'use_skill') return named('用技能', 'Use skill', str(args?.name) || str(args?.skill));
  if (toolKey === 'save_skill') return named('存成技能', 'Save as skill', str(args?.name) || str(args?.id));
  if (toolKey === 'cron_create') {
    const when = str(args?.cron) || str(args?.schedule);
    if (when && args?.recurring === false) return q(`定个一次性任务 · ${when.split(/\s+/).slice(0, 2).reverse().map((x) => x.padStart(2, '0')).join(':')}`, 'Schedule once');
    return when ? q(`设成自动化 · ${cronToHuman(when, true)}`, `Automate · ${cronToHuman(when, false)}`) : q('设成自动化', 'Automate');
  }
  if (toolKey === 'cron_list') return q('看看已有的自动化', 'Check automations');
  if (toolKey === 'cron_delete') return q('取消自动化', 'Cancel an automation');
  if (toolKey === 'memory' || toolKey === 'save_memory' || toolKey === 'update_profile') return q('记下来', 'Note it down');

  /* 文件 / 文档 */
  if (toolKey === 'read_document') return named('读文件', 'Read', file);
  if (toolKey === 'pptx_read') return named('看演示稿', 'Review slides', doc);
  if (toolKey === 'pptx_replace_text') return named('修改演示稿', 'Edit slides', doc);
  if (toolKey === 'unpack') return named('解压', 'Unpack', file);
  if (toolKey === 'delete_file') return named('删掉', 'Delete', file);
  if (toolKey === 'rename_file') return named('改名', 'Rename', file);
  if (toolKey === 'create_directory') return pick(INTERNAL.browse);
  /* 图 / 视频 / 分享 */
  if (toolKey === 'render_video') return named('做视频', 'Make a video', doc || str(args?.title));
  if (toolKey === 'share_page') return q('生成分享链接', 'Create a share link');
  /* 网页 (浏览器) —— 一连串点点填填合成一行「操作网页」 */
  if (toolKey === 'browser_navigate' || toolKey === 'browser_new_tab') {
    const url = str(args?.url);
    return url ? named('打开网页', 'Open', hostOf(url)) : q('打开网页', 'Open a page');
  }
  if (/^browser_(get_text|query|get_aria_tree|get_state|screenshot|get_response_body)$/.test(toolKey)) return q('看网页内容', 'Read the page');
  if (/^browser_(fill_form|type|keyboard_type|select_option|set_input_files|choose)$/.test(toolKey)) return q('在网页上填写', 'Fill in the page');
  if (/^browser/.test(toolKey)) return q('操作网页', 'Work in the browser');
  /* 电脑 */
  if (toolKey === 'computer_snapshot') return q('看一眼屏幕', 'Look at the screen');
  if (/^computer/.test(toolKey)) return q('操作电脑', 'Use the computer');
  /* 调研 / 分工 */
  if (toolKey === 'team_run') return q('分给团队一起做', 'Hand it to the team');
  if (toolKey === 'agent' || /^task_(create|update)$/.test(toolKey)) return named('交给帮手', 'Hand off', str(args?.description) || str(args?.title));
  if (/^task_(get|list|output)$/.test(toolKey) || toolKey === 'list_pending_tasks') return q('看帮手进度', 'Check on helpers');
  if (toolKey === 'task_stop') return q('让帮手停下', 'Stop a helper');
  /* 知识库 / 记忆 */
  if (toolKey === 'knowledge_search') return named('翻资料库', 'Search your library for', str(args?.query));
  if (toolKey === 'knowledge_add') return q('存进资料库', 'Save to your library');
  /* 生活 */
  if (toolKey === 'calendar_events') return q('看日程', 'Check the calendar');
  if (toolKey === 'calendar_add') return named('加日程', 'Add to calendar', str(args?.title));
  if (toolKey === 'apple_reminders' || toolKey === 'schedule_reminder') return named('设提醒', 'Set a reminder', str(args?.title) || str(args?.text));
  if (/^cron_(create|delete|list)$/.test(toolKey) || toolKey === 'schedule_wakeup') return q('安排定时任务', 'Schedule a task');
  if (toolKey === 'contacts_search') return named('找联系人', 'Look up', str(args?.query) || str(args?.name));
  if (toolKey === 'send_imessage') return q('发消息', 'Send a message');
  if (toolKey === 'call_user' || toolKey === 'phone') return q('用手机办', 'Use the phone');
  if (toolKey === 'maps') return named('查地图', 'Check the map for', str(args?.query) || str(args?.destination));
  if (toolKey === 'get_weather') return named('查天气', 'Check the weather in', str(args?.location) || str(args?.city));
  /* 跟你说 / 计划 / 找工具 */
  if (toolKey === 'report_to_user') return q('跟你汇报', 'Report back');
  if (toolKey === 'update_todos' || toolKey === 'edit_plan') return q('理一下步骤', 'Plan the steps');
  if (toolKey === 'tool_search' || toolKey === 'call_tool') return q('找合适的工具', 'Find the right tool');
  if (/^execute_(code|python|javascript)$/.test(toolKey) || toolKey === 'ptc_execute') return pick(INTERNAL.shell);
  /* MCP: mcp__服务名__工具 —— 说清是哪家服务 */
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(toolKey);
  if (mcp) return named('用外部服务', 'Use', mcp[1]!.replace(/[-_]/g, ' '));
  return undefined;
}

/**
 * Work 模式下一步的内容。返回 undefined = 不拦, 走原来的内容构建 (比如图片结果卡、搜索结果)。
 *
 * 拦的是会露出"代码"的那几类: 命令 / 脚本 / diff / 原始文件内容 / 表格文档工具的原始 JSON。
 * 失败只说"这一步没成功", 不贴报错原文 —— 助理会自己换办法, 老板不需要看堆栈。
 */
export function plainWorkContent(
  toolKey: string,
  args: Record<string, unknown> | undefined,
  failed: boolean,
  isZh: boolean,
): StepContent | undefined {
  const technical = SHELL_TOOLS.has(toolKey) || WRITE_TOOLS.has(toolKey) || EDIT_TOOLS.has(toolKey)
    || READ_TOOLS.has(toolKey) || FIND_TOOLS.has(toolKey)
    || /^(sheet|word|deck)_/.test(toolKey) || toolKey === 'create_slides' || toolKey === 'list_slide_templates'
    || toolKey === 'open_surface' || toolKey === 'update_surface' || toolKey === 'use_skill';
  if (!technical) return undefined;
  if (failed) {
    return {
      type: 'log',
      level: 'warning',
      message: isZh ? '这一步没成功, 正在换个办法' : "This step didn't work — trying another way",
    };
  }
  return plainChange(toolKey, args, isZh) ?? { type: 'none' };
}

const CHANGE_MAX = 6;
const TEXT_MAX = 80;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const text = (v: unknown): string => {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

function plainFormula(formula: string, isZh: boolean): string {
  const fn = /^=\s*([A-Z]+)\s*\(/i.exec(formula)?.[1]?.toUpperCase();
  const zh: Record<string, string> = { SUM: '自动求和', AVERAGE: '自动求平均', COUNT: '自动计数', MAX: '自动取最大值', MIN: '自动取最小值', IF: '按条件自动填' };
  const en: Record<string, string> = { SUM: 'Adds up automatically', AVERAGE: 'Averages automatically', COUNT: 'Counts automatically', MAX: 'Takes the max', MIN: 'Takes the min', IF: 'Fills by a rule' };
  return (fn && (isZh ? zh : en)[fn]) || (isZh ? '自动计算' : 'Calculated automatically');
}

function formatWords(args: Record<string, unknown>, isZh: boolean): string {
  const parts: string[] = [];
  if (args.bold) parts.push(isZh ? '加粗' : 'bold');
  if (args.italic) parts.push(isZh ? '斜体' : 'italic');
  if (args.underline) parts.push(isZh ? '下划线' : 'underlined');
  if (text(args.color)) parts.push(isZh ? '改颜色' : 'recolored');
  if (text(args.highlight)) parts.push(isZh ? '高亮' : 'highlighted');
  return parts.join(isZh ? '、' : ', ') || (isZh ? '改格式' : 'reformatted');
}

function changeOf(items: Array<{ label?: string; before?: string; after?: string }>): StepContent | undefined {
  const kept = items
    .map((it) => ({
      ...(it.label ? { label: it.label } : {}),
      ...(it.before ? { before: clip(it.before, TEXT_MAX) } : {}),
      ...(it.after ? { after: clip(it.after, TEXT_MAX) } : {}),
    }))
    .filter((it) => it.label || it.before || it.after);
  if (kept.length === 0) return undefined;
  const shown = kept.slice(0, CHANGE_MAX);
  return { type: 'change', items: shown, ...(kept.length > shown.length ? { more: kept.length - shown.length } : {}) };
}

/* ── 改稿的真实前后对照 (work:Q-10) ─────────────────────────────────────
 * 工具结果里带着写盘前后对比出来的 changes [{index, before, after}], 比参数更可信:
 * 参数只说"想改成什么", 这里说的是"文件里真的从什么变成了什么"。
 * 结果被 contextual 信封包过一层时, 真载荷在 metadata 或 content 字符串里。 */
export function plainChangeFromOutput(
  toolKey: string,
  output: string | undefined,
  isZh: boolean,
): StepContent | undefined {
  if (!output || !/^word_/.test(toolKey)) return undefined;
  let parsed: any;
  try { parsed = JSON.parse(output.trim().replace(/^⏱️[^\n]*\n/, '')); } catch { return undefined; }
  if (parsed && typeof parsed === 'object' && typeof parsed.tool === 'string' && typeof parsed.status === 'string') {
    if (parsed.metadata && typeof parsed.metadata === 'object') parsed = parsed.metadata;
    else if (typeof parsed.content === 'string') {
      try { parsed = JSON.parse(parsed.content); } catch { return undefined; }
    } else return undefined;
  }
  const changes = Array.isArray(parsed?.changes) ? parsed.changes : null;
  if (!changes?.length) return undefined;
  const q = (zh: string, en: string) => (isZh ? zh : en);
  return changeOf(changes.map((c: any) => {
    const idx = typeof c?.index === 'number' ? c.index : undefined;
    const before = typeof c?.before === 'string' ? c.before : '';
    const after = typeof c?.after === 'string' ? c.after : '';
    return {
      label: before && after
        ? q(`第 ${(idx ?? 0) + 1} 段`, `Paragraph ${(idx ?? 0) + 1}`)
        : after
          ? q('加了一段', 'Added a paragraph')
          : q(`删掉第 ${(idx ?? 0) + 1} 段`, `Removed paragraph ${(idx ?? 0) + 1}`),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    };
  }));
}

/** Work 工具的白话内容: 改稿工具优先用结果里的真实前后对照 (work:Q-10), 其余按参数拼 */
export function plainWorkContentForTool(
  toolKey: string,
  args: Record<string, unknown> | undefined,
  output: string | undefined,
  failed: boolean,
  isZh: boolean,
): StepContent | undefined {
  if (!failed) {
    const fromResult = plainChangeFromOutput(toolKey, output, isZh);
    if (fromResult) return fromResult;
  }
  return plainWorkContent(toolKey, args, failed, isZh);
}

export function plainChange(
  toolKey: string,
  args: Record<string, unknown> | undefined,
  isZh: boolean,
): StepContent | undefined {
  if (!args) return undefined;
  const q = (zh: string, en: string) => (isZh ? zh : en);
  const nth = (i: number | undefined) => (i === undefined ? '' : String(i + 1));

  switch (toolKey) {
    case 'word_replace_text':
      return changeOf([{ before: text(args.find), after: text(args.replace) || q('(删掉)', '(removed)') }]);
    case 'word_edit_paragraph':
      return changeOf([{ label: q(`改写第 ${nth(num(args.index))} 段`, `Rewrote paragraph ${nth(num(args.index))}`), after: text(args.new_text) }]);
    case 'word_insert_paragraph':
      return changeOf([{ label: q('加了一段', 'Added a paragraph'), after: text(args.new_text) }]);
    case 'word_delete_paragraph':
      return changeOf([{ label: q(`删掉第 ${nth(num(args.index))} 段`, `Removed paragraph ${nth(num(args.index))}`) }]);
    case 'word_set_cell': {
      const where = q(
        `表格 ${nth(num(args.table_index))} · 第 ${nth(num(args.row))} 行第 ${nth(num(args.col))} 列`,
        `Table ${nth(num(args.table_index))} · row ${nth(num(args.row))}, column ${nth(num(args.col))}`,
      );
      return changeOf([{ label: where, after: text(args.text) }]);
    }
    case 'word_format_text':
      return changeOf([{ label: q(`设成${formatWords(args, true)}`, `Made it ${formatWords(args, false)}`), after: text(args.find) }]);
    case 'word_insert_table': {
      const rows = Array.isArray(args.rows) ? (args.rows as unknown[]) : [];
      if (rows.length === 0) return undefined;
      const first = Array.isArray(rows[0]) ? (rows[0] as unknown[]).map(text).filter(Boolean).join(' · ') : '';
      return changeOf([{ label: q(`插入一个 ${rows.length} 行的表格`, `Inserted a ${rows.length}-row table`), after: first }]);
    }
    case 'word_insert_image':
      return changeOf([{ label: q('插入图片', 'Inserted an image'), after: text(args.caption) || baseName(text(args.image_path)) }]);
    case 'sheet_set_cells': {
      const cells = Array.isArray(args.cells) ? (args.cells as Array<Record<string, unknown>>) : [];
      return changeOf(cells.map((c) => {
        /* 模型常把公式直接写进 value (「=B2-C2」), 一样当公式说人话 */
        const value = text(c.value);
        const formula = text(c.formula) || (value.startsWith('=') ? value : '');
        return { label: text(c.cell), after: formula ? plainFormula(formula, isZh) : (value || q('(清空)', '(cleared)')) };
      }));
    }
    case 'sheet_write_range': {
      const data = Array.isArray(args.data) ? (args.data as unknown[]) : [];
      if (data.length === 0) return undefined;
      const head = Array.isArray(data[0]) ? (data[0] as unknown[]).map(text).filter(Boolean).join(' · ') : '';
      return changeOf([{ label: q(`填了 ${data.length} 行`, `Filled ${data.length} rows`), after: head }]);
    }
    default:
      return undefined;
  }
}
