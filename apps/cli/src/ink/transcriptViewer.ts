/**
 * ctrl+o 完整记录 —— 备用屏 (alt screen) 里的只读滚动视图。
 *
 *   ↑↓ / j k 一行 · PgUp PgDn / 空格 一屏 · g G 顶/底 · q / Esc / ctrl+o 返回
 *
 * 为什么不用 Ink 画: 时间线大部分在 Ink 的 <Static> 里, 已经写进终端滚动区、改不了;
 * 一个能上下翻的全屏视图只能在备用屏里自己画。打开期间:
 *   · 暂停 Ink 的输出 (否则 spinner/状态行的重绘会写进备用屏, 把视图画花);
 *   · isTranscriptOpen() 为真, 输入框/快捷键一律不处理按键 (否则 j/k/q 会打进输入框)。
 * 退出时回到主屏 —— 主屏内容原样还在 (备用屏不碰主屏的滚动区)。
 */
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { getLanguage } from '../i18n/index.js';

let open = false;
let closedAt = 0;

/** 刚关的 150ms 内也算开着 —— 关闭用的那个按键 (ctrl+o) 同时也会送到 App 的快捷键处理, 别让它立刻又打开 */
export function isTranscriptOpen(): boolean {
  return open || Date.now() - closedAt < 150;
}

const ESC = '\x1b';
const dim = (s: string) => `${ESC}[2m${s}${ESC}[22m`;

export function openTranscript(
  lines: string[],
  opts: { title: string; hint: string; write: (s: string) => void; setInkPaused: (p: boolean) => void },
): void {
  if (open) return;
  open = true;
  const out = process.stdout;
  const stdin = process.stdin;
  const realWrite = opts.write;

  let wrapped: string[] = [];
  let top = 0;
  const rows = () => Math.max(5, (out.rows || 24));
  const cols = () => Math.max(20, (out.columns || 80));
  const bodyH = () => rows() - 2;

  const rewrap = () => {
    const w = cols() - 2;
    wrapped = [];
    for (const l of lines) {
      const segs = wrapAnsi(l, w, { hard: true, trim: false }).split('\n');
      for (const s of segs) wrapped.push(s);
    }
  };

  const draw = () => {
    const h = bodyH();
    const maxTop = Math.max(0, wrapped.length - h);
    top = Math.max(0, Math.min(top, maxTop));
    let buf = `${ESC}[H${ESC}[2J`;
    const pos = wrapped.length === 0 ? '' : `${Math.min(wrapped.length, top + h)}/${wrapped.length}`;
    const head = ` ${opts.title}`;
    buf += `${ESC}[1m${head}${ESC}[22m${' '.repeat(Math.max(1, cols() - stringWidth(head) - stringWidth(pos) - 1))}${dim(pos)}\r\n`;
    for (let i = 0; i < h; i++) {
      const l = wrapped[top + i];
      buf += (l !== undefined ? ' ' + l : '') + `${ESC}[0m\r\n`;
    }
    buf += dim(' ' + opts.hint);
    realWrite(buf);
  };

  opts.setInkPaused(true);
  realWrite(`${ESC}[?1049h${ESC}[?25l`);
  rewrap();
  top = Math.max(0, wrapped.length - bodyH()); // 从最新处开始
  draw();

  const onResize = () => { rewrap(); draw(); };
  const close = (why = 'key') => {
    void why;
    stdin.off('data', onData);
    out.off('resize', onResize);
    realWrite(`${ESC}[?25h${ESC}[?1049l`);
    opts.setInkPaused(false);
    open = false;
    closedAt = Date.now();
    closeListeners.forEach(fn => { try { fn(); } catch { /* */ } });
  };
  const openedAt = Date.now();
  const onData = (d: Buffer | string) => {
    /* 打开它的那个 ctrl+o 可能随后又投递到这里 (Ink 走 readable, 这里挂 data) —— 头 150ms 不收, 否则一开就关 */
    if (Date.now() - openedAt < 150) return;
    const s = d.toString();
    const h = bodyH();
    if (s === 'q' || s === ESC || s === '\x0f' || s === '\x03') return close(JSON.stringify(s));
    if (s === `${ESC}[A` || s === 'k') top -= 1;
    else if (s === `${ESC}[B` || s === 'j') top += 1;
    else if (s === `${ESC}[5~` || s === 'b') top -= h;
    else if (s === `${ESC}[6~` || s === ' ') top += h;
    else if (s === 'g' || s === `${ESC}[H`) top = 0;
    else if (s === 'G' || s === `${ESC}[F`) top = wrapped.length;
    else return;
    draw();
  };
  stdin.on('data', onData);
  out.on('resize', onResize);
}

/** 时间线 entry → 纯文本行 (思考、工具明细全部展开; 颜色只保留最淡的几种, 读起来像日志) */
export function entriesToTranscript(entries: Array<Record<string, any>>, zh: boolean): string[] {
  const out: string[] = [];
  const B = (s: string) => `${ESC}[1m${s}${ESC}[22m`;
  const P = (s: string) => `${ESC}[38;2;138;108;255m${s}${ESC}[39m`;
  const push = (head: string, body?: string) => {
    if (out.length) out.push('');
    out.push(head);
    if (body && body.trim()) for (const l of body.replace(/\s+$/, '').split('\n')) out.push('  ' + l);
  };
  const textOf = (e: Record<string, any>): string => {
    if (e.text) return String(e.text);
    const c = e.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
    return '';
  };
  for (const e of entries) {
    const t = e.type as string;
    const text = textOf(e);
    if (t === 'header_reemit' || t === 'tool_group') continue;
    if (t === 'user' || t === 'queued_message') { push(P('› ') + B(text)); continue; }
    if (t === 'assistant') { if (text.trim()) push('● ' + text.split('\n')[0], text.split('\n').slice(1).join('\n')); continue; }
    if (t === 'thinking' || t === 'reasoning') { push(dim(`∴ ${zh ? '思考' : 'Thinking'}`), text.split('\n').map(dim).join('\n')); continue; }
    if (t === 'plan' && Array.isArray(e.planSteps)) {
      push('● Plan', e.planSteps.map((s: any) => `${s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '◐' : '○'} ${s.step}`).join('\n'));
      continue;
    }
    if (t === 'task_agent_progress') {
      push(`● ${e.taskAgentRole || 'Agent'}(${e.taskAgentTask || ''})`,
        (e.taskAgentToolRecords || []).map((r: any) => `${r.name}${r.args ? ' ' + r.args : ''}`).join('\n'));
      continue;
    }
    if (!text && !e.details) continue;
    /* 其余 (工具 / info / 错误): 类型名 + 摘要, 明细整段缩进 —— 这里是"看全"的地方, 不截断 */
    push(`● ${B(t)} ${text.split('\n')[0]}`, [text.split('\n').slice(1).join('\n'), e.details || ''].filter(Boolean).join('\n'));
  }
  if (out.length === 0) out.push(dim(zh ? '(还没有记录)' : '(nothing yet)'));
  return out;
}

export function openFullTranscript(opts: {
  entries: Array<Record<string, any>>;
  write: (s: string) => void;
  setInkPaused: (p: boolean) => void;
  onClosed: () => void;
}): void {
  if (isTranscriptOpen()) return;
  let zh = false;
  try { zh = getLanguage() === 'zh'; } catch { /* */ }
  const lines = entriesToTranscript(opts.entries, zh);
  const off = onTranscriptClosed(() => { off(); opts.onClosed(); });
  try {
    cliLogger.info('TRANSCRIPT', `open (${lines.length} lines)`);
    openTranscript(lines, {
      title: zh ? '完整记录' : 'Transcript',
      hint: zh ? '↑↓ 滚动 · PgUp/PgDn 翻页 · g/G 顶部/底部 · q 返回' : '↑↓ scroll · PgUp/PgDn page · g/G top/bottom · q back',
      write: opts.write,
      setInkPaused: opts.setInkPaused,
    });
  } catch (err) {
    off();
    cliLogger.warn('TRANSCRIPT', 'open failed', { error: String((err as Error)?.stack || err) });
  }
}

const closeListeners = new Set<() => void>();
/** 视图关闭后要做的事 (Ink 各区重绘) */
export function onTranscriptClosed(fn: () => void): () => void {
  closeListeners.add(fn);
  return () => closeListeners.delete(fn);
}
