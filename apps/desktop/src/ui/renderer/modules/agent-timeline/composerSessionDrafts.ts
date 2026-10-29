import type { Attachment } from '../../../shared/ipc';

const attachmentDrafts = new Map<string, Attachment[]>();
const homeTextDrafts = new Map<string, string>();

export const HOME_DRAFT_PREFIX = '__home__:';

export function homeDraftKey(mode: 'work' | 'code' | 'pilot'): string {
  return `${HOME_DRAFT_PREFIX}${mode}`;
}

export function isHomeDraftKey(key: string): boolean {
  return key.startsWith(HOME_DRAFT_PREFIX);
}

export interface ComposerDraftSwap {
  /** 换上来的会话该显示的文字; null = 有会话, 由调用方从 localStorage 读 */
  homeText: string | null;
  attachments: Attachment[];
}

/**
 * 从 prev 切到 next: prev 的附件 (首页还有文字) 存起来, 取出 next 的。
 * discardPrev = 刚从首页发出了第一条消息、会话随之建出来 —— 首页那份已经发走了,
 * 再存就会在下次「新建任务」时原样冒出来。
 */
export function swapComposerDraft(
  prev: string | null,
  next: string,
  current: { text: string; attachments: Attachment[] },
  opts: { discardPrev?: boolean } = {},
): ComposerDraftSwap {
  if (prev !== null && prev !== next) stashComposerDraft(prev, current, opts);
  const attachments = attachmentDrafts.get(next) ?? [];
  attachmentDrafts.delete(next);
  return {
    homeText: isHomeDraftKey(next) ? (homeTextDrafts.get(next) ?? '') : null,
    attachments,
  };
}

export function stashComposerDraft(
  key: string,
  current: { text: string; attachments: Attachment[] },
  opts: { discardPrev?: boolean } = {},
): void {
  if (opts.discardPrev) {
    attachmentDrafts.delete(key);
    if (isHomeDraftKey(key)) homeTextDrafts.delete(key);
    return;
  }
  if (current.attachments.length > 0) attachmentDrafts.set(key, current.attachments.slice());
  else attachmentDrafts.delete(key);
  if (isHomeDraftKey(key)) {
    if (current.text) homeTextDrafts.set(key, current.text);
    else homeTextDrafts.delete(key);
  }
}

/** 删会话时顺手丢掉它的附件草稿 (测试也用它复位) */
export function forgetComposerDraft(key: string): void {
  attachmentDrafts.delete(key);
  homeTextDrafts.delete(key);
}

export function __resetComposerDraftsForTest(): void {
  attachmentDrafts.clear();
  homeTextDrafts.clear();
}
