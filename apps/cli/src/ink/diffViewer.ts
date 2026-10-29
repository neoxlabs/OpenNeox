/**
 * ctrl+d 全屏看 diff (CLI-04)
 *
 * 卡片里的 diff 默认只显示 12 行, 长改动看不清。这里把时间线条目里存的 diff 明细
 * 还原成一个可在备用屏里滚动的只读视图 —— 复用 ctrl+o 完整记录那套备用屏实现
 * (transcriptViewer.openTranscript): 暂停 Ink 输出、按键归它、退出回主屏。
 *
 * 为什么不在 Ink 里画: 时间线大部分在 <Static> 里, 已经写进终端滚动区, 改不了;
 * 能上下翻的全屏视图只能在备用屏里自己画。
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { openTranscript, isTranscriptOpen, onTranscriptClosed } from './transcriptViewer.js';
import { collectDiffViewerSections, renderDiffSectionLines, type DiffViewerSection } from './utils/diffDisplay.js';
import { getLanguage } from '../i18n/index.js';

const ESC = '\x1b';
const dim = (s: string): string => `${ESC}[2m${s}${ESC}[22m`;
const bold = (s: string): string => `${ESC}[1m${s}${ESC}[22m`;

/**
 * 分段 → 备用屏里的文本行 (纯函数, 单测直接断言)。
 * 段与段之间空一行; 每段先给一行标题 (文件名 / +N −M)。
 */
export function buildDiffViewerLines(sections: DiffViewerSection[], opts: { zh?: boolean } = {}): string[] {
  const zh = opts.zh === true;
  const out: string[] = [];
  for (const section of sections) {
    if (out.length > 0) out.push('');
    out.push(bold(section.title));
    for (const line of renderDiffSectionLines(section)) out.push('  ' + line);
  }
  if (out.length === 0) out.push(dim(zh ? '(这次会话还没有改动)' : '(no diffs in this session yet)'));
  return out;
}

export interface OpenDiffViewerOptions {
  /** 时间线条目 (static + pending 都传进来) */
  entries: Array<Record<string, any>>;
  write: (s: string) => void;
  setInkPaused: (paused: boolean) => void;
  onClosed?: () => void;
}

/**
 * 打开全屏 diff 视图。返回是否真的打开了 (备用屏已经被别的东西占着 / 出错时为 false)。
 * 打开期间 isTranscriptOpen() 为真, App 的快捷键与输入框都不处理按键。
 */
export function openDiffFullscreen(opts: OpenDiffViewerOptions): boolean {
  if (isTranscriptOpen()) return false;
  let zh = false;
  try { zh = getLanguage() === 'zh'; } catch { /* 语言读不到就按英文 */ }

  const sections = collectDiffViewerSections(opts.entries);
  const lines = buildDiffViewerLines(sections, { zh });

  const off = onTranscriptClosed(() => { off(); opts.onClosed?.(); });
  try {
    cliLogger.info('DIFF_VIEW', `open (${sections.length} sections, ${lines.length} lines)`);
    openTranscript(lines, {
      title: zh ? '改动' : 'Changes',
      hint: zh
        ? '↑↓ 滚动 · PgUp/PgDn 翻页 · g/G 顶部/底部 · q 返回'
        : '↑↓ scroll · PgUp/PgDn page · g/G top/bottom · q back',
      write: opts.write,
      setInkPaused: opts.setInkPaused,
    });
    return true;
  } catch (err) {
    off();
    cliLogger.warn('DIFF_VIEW', 'open failed', { error: String((err as Error)?.stack || err) });
    return false;
  }
}
