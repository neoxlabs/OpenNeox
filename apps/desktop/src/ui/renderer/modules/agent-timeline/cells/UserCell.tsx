/* ============================================================
 * UserCell — 用户消息气泡 (设计文档 §6.2)
 *   从 MessageRow.tsx 抽出 (Phase 3.7).
 *
 *   独有特性:
 *   - 文字超过 140px 高度时 clamp + "Show more / less" 按钮
 *   - header hover 出现 编辑并重发 + 复制
 *   - footer 始终显示 时间 + 复制 + 编辑
 *
 *   不处理: streaming / typing / cursor — 用户消息永不 streaming.
 *   系统消息 (background-task-notification / agent-completion / scheduled-wakeup) 已被
 *   MessageRow router 在更早的阶段路由到对应 cell, 不会到这里.
 * ============================================================ */

import React, { useEffect, useRef, useState } from 'react';
import type { TimelineMessage } from '../types';
import TimelineTextRenderer from '../TimelineTextRenderer';
import { MessageAttachmentChip, Lightbox } from './attachments';
import { useI18n } from '../../../hooks/useI18n';
import {
  FooterCopyButton,
  FooterEditButton,
  FooterRewindButton,
} from './messageButtons';

interface Props {
  message: TimelineMessage;
}

const CLAMP_HEIGHT_PX = 140;


const HAS_RICH_CARD = /^\s*```neox(-card)?\b/m;

export const UserCell: React.FC<Props> = ({ message }) => {
  const { isZh } = useI18n();
  const [lightbox, setLightbox] = useState<{ src: string; name?: string; size?: number } | null>(null);
  const [textExpanded, setTextExpanded] = useState(false);
  const [textOverflows, setTextOverflows] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    if (HAS_RICH_CARD.test(message.text || '')) { setTextOverflows(false); return; }
    setTextOverflows(el.scrollHeight > CLAMP_HEIGHT_PX + 4);
  }, [message.text]);

  const hasAttachments = !!(message.attachments && message.attachments.length > 0);
  if (!(message.text || '').trim() && !hasAttachments) {
    return null;
  }
  const imagesBack = (): Array<{ name?: string; data: string }> => (message.attachments ?? [])
    .filter((a) => a.kind === 'image' && typeof a.data === 'string' && a.data.startsWith('data:'))
    .map((a) => ({ name: a.name, data: a.data! }));

  return (
    <div className="atl-msg is-user">
      <span className="atl-msg__rail" aria-hidden="true" />
      <div className="atl-msg__body">
        <div className="atl-msg__meta">
          <span className="atl-msg__role">{isZh ? '你' : 'You'}</span>
          {message.injectionPending && (
            <span role="status" aria-live="polite">{isZh ? '插话待处理' : 'Insertion pending'}</span>
          )}
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <div className="atl-msg__attach">
            {message.attachments.map((a) => (
              <MessageAttachmentChip key={a.id} att={a} onPreview={(url) => setLightbox({ src: url, name: a.name, size: a.size })} />
            ))}
          </div>
        )}
        {message.text && (
          <div className="atl-msg__text atl-msg__text--user">
            <div
              ref={textRef}
              className={textOverflows && !textExpanded ? 'atl-msg__text-clamp' : undefined}
            >
              <div className="atl-msg__plain">{message.text}</div>
            </div>
            {textOverflows && (
              <button
                type="button"
                className="atl-msg__showmore"
                onClick={(e) => { e.stopPropagation(); setTextExpanded(v => !v); }}
              >
                {textExpanded ? (isZh ? '收起' : 'Show less') : (isZh ? '展开全部' : 'Show more')} {textExpanded ? '▴' : '▾'}
              </button>
            )}
          </div>
        )}
        {(message.text || hasAttachments) && (
          <div className="atl-msg__footer atl-msg__footer--user">
            {message.timestamp && <span className="atl-msg__footer-time">{message.timestamp}</span>}
            {message.text && <FooterCopyButton text={message.text} />}
            <FooterEditButton onEdit={() => {
              window.dispatchEvent(new CustomEvent('neox:composer:edit-message', {
                detail: { entryId: message.id, text: message.text ?? '', images: imagesBack() },
              }));
            }} />
            <FooterRewindButton onRewind={() => {
              window.dispatchEvent(new CustomEvent('neox:message:rewind', {
                detail: { entryId: message.id, text: message.text, images: imagesBack() },
              }));
            }} />
          </div>
        )}
      </div>
      {lightbox && <Lightbox src={lightbox.src} name={lightbox.name} size={lightbox.size} onClose={() => setLightbox(null)} />}
    </div>
  );
};
