
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from '../../../../components/Markdown';
import { planMarkdownChunks } from './markdownChunks';
import './progressiveMarkdown.css';

interface Props {
  content: string;
  basePath?: string;
  workspacePath?: string;
}

export const ProgressiveMarkdown: React.FC<Props> = ({ content, basePath, workspacePath }) => {
  const chunks = useMemo(() => planMarkdownChunks(content), [content]);
  const [shown, setShown] = useState(1);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  /* 换了文档就从头来 (chunks 是新的数组实例) */
  useEffect(() => { setShown(1); }, [chunks]);

  const visible = Math.min(Math.max(shown, 1), chunks.length || 1);

  useEffect(() => {
    if (visible >= chunks.length) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setShown(chunks.length);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        setShown(n => Math.min(chunks.length, n + 1));
      }
    }, { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, chunks]);

  /* 单块 (普通文档 / 不方便切的文档) —— 保持和改动前一模一样。 */
  if (chunks.length <= 1) {
    return <Markdown content={content} basePath={basePath} workspacePath={workspacePath} />;
  }

  return (
    <div className="sfc-doc__chunks" data-chunks={chunks.length} data-rendered={visible}>
      {chunks.slice(0, visible).map((chunk, i) => (
        <div className="sfc-doc__chunk" key={i} data-chunk={i}>
          <Markdown content={chunk} basePath={basePath} workspacePath={workspacePath} />
        </div>
      ))}
      {visible < chunks.length && (
        <div
          ref={sentinelRef}
          className="sfc-doc__sentinel"
          data-remaining={chunks.length - visible}
          aria-hidden="true"
        />
      )}
    </div>
  );
};

export default ProgressiveMarkdown;
