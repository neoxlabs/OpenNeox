import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from '../../components/Markdown';
import { fenceBareJson } from './fenceBareJson';
import { msSinceStreamFreeze } from '../../state/streamActivity';
import { isTimelineUserScrollGuardActive } from './timelineScrollGuard';

interface Props {
  content: string;
  streaming?: boolean;
  className?: string;
  instant?: boolean;
}

/* 流式逐字节奏 — "打字机"丝滑感
 *   旧版 MIN_CPS=900 + MAX_FRAME_CHARS=280 意味着 60fps 下一帧最多塞 280 字符,
 *   一秒钟 900+ 字符往屏幕上糊, 肉眼根本看不到"一个一个流出来", 像瞬现.
 *
 *   人眼舒适阅读速度: 英文 ~25 字符/秒, 中文 ~8 字符/秒. 流式输出做到阅读速度的
 *   1.5-3 倍 (~ 40-120 字符/秒) 既不憋着也不糊脸. 每帧 1-7 字符的"水流感".
 *
 *   两套参数:
 *   - streaming 中: 慢节奏丝滑 (MIN=30, MAX=400 cps; 每帧 1-7 字符)
 *   - streaming 结束: 快速清场 backlog (MIN=600, MAX=4000 cps; 每帧 1-64 字符).
 *     结束阶段不需要丝滑, 用户已切走注意力, 残留 backlog 越快清越好,
 *     否则就是"我都说完了它还在慢慢吐". */
const STREAM_TEXT_TARGET_DRAIN_MS = 800;
const STREAM_TEXT_FINAL_DRAIN_MS = 500;
const STREAM_TEXT_STREAMING_MIN_CPS = 30;
const STREAM_TEXT_STREAMING_MAX_CPS = 400;
const STREAM_TEXT_FINAL_MIN_CPS = 600;
const STREAM_TEXT_FINAL_MAX_CPS = 4000;
const STREAM_TEXT_MIN_FRAME_CHARS = 1;
const STREAM_TEXT_STREAMING_MAX_FRAME_CHARS = 7;
const STREAM_TEXT_FINAL_MAX_FRAME_CHARS = 64;
const STREAM_TEXT_PRESSURE_FRAME_MS = 22;
const STREAM_TEXT_PRESSURE_MAX_FRAME_CHARS = 48;
const STREAM_TEXT_PRESSURE_BACKLOG = 320;
const STREAM_TEXT_COMMIT_INTERVAL_MS = 32;

/** 积压超过这么多字 (模型出字明显快于打字机) 就改成整段放出 */
export const STREAM_PARAGRAPH_BACKLOG = 160;

export function paragraphRevealEnd(visibleLen: number, target: string, streaming: boolean): number | null {
  if (!streaming) return null;
  if (target.length - visibleLen <= STREAM_PARAGRAPH_BACKLOG) return null;
  const idx = target.lastIndexOf('\n\n');
  if (idx < 0) return null;
  const end = idx + 2;
  return end > visibleLen ? end : null;
}

/**
 * 掉帧 / 超大积压时跳到最近换行: 少几次 setState, 把主线程让给 layout。
 * 观感仍是"一段段出来", 只是机器忙时不再死守每帧 1~7 字。
 */
export function pressureRevealEnd(
  visibleLen: number,
  target: string,
  streaming: boolean,
  lastFrameMs: number,
): number | null {
  if (!streaming) return null;
  const backlog = target.length - visibleLen;
  if (lastFrameMs <= STREAM_TEXT_PRESSURE_FRAME_MS && backlog < STREAM_TEXT_PRESSURE_BACKLOG) return null;
  const idx = target.lastIndexOf('\n');
  if (idx < 0) return null;
  const end = idx + 1;
  return end > visibleLen ? end : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function safeSliceEnd(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return clamp(index, 0, text.length);
  const code = text.charCodeAt(index);
  /* Avoid cutting between UTF-16 surrogate pairs. Markdown can tolerate partial
   * tokens while streaming, but broken surrogate pairs render as replacement glyphs. */
  if (code >= 0xdc00 && code <= 0xdfff) return index - 1;
  return index;
}

function useTimelineTextContent(content: string, streaming: boolean, instant = false): string {
  const [visible, setVisible] = useState(content);
  const latestRef = useRef(content);
  const visibleRef = useRef(content);
  const rafRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const carryRef = useRef(0);
  const prevStreamingRef = useRef(streaming);

  const stopLoop = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastFrameAtRef.current = null;
    carryRef.current = 0;
  };

  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = streaming;
    latestRef.current = content;

    if (content.length < visibleRef.current.length) {
      visibleRef.current = content;
      setVisible(content);
    }

    const frozenJustNow = msSinceStreamFreeze() < 400;
    const shouldAnimate =
      !instant && !frozenJustNow && (
        streaming ||
        (wasStreaming && visibleRef.current.length < content.length) ||
        rafRef.current !== null
      );

    if (!shouldAnimate) {
      stopLoop();
      visibleRef.current = content;
      setVisible(content);
      return;
    }

    if (rafRef.current !== null) return;

    const tick = (now: number) => {
      if (isTimelineUserScrollGuardActive()) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (lastFrameAtRef.current === null) {
        lastFrameAtRef.current = now;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const last = lastFrameAtRef.current;
      const target0 = latestRef.current;
      const current0 = visibleRef.current;
      /* 提交节流: 没攒够 32ms 就跳过这一帧, 不 setState (见 STREAM_TEXT_COMMIT_INTERVAL_MS)。
       * 这里**不更新 lastFrameAtRef** —— elapsed 继续累积, 下次提交时一次多吐几个字,
       * 所以吐字速度不变, 只是少了一半的重渲染。
       * 段落整段揭示要立刻落地 (它是"一段浮现"的观感), 所以先放行再判节流。 */
      if (
        now - last < STREAM_TEXT_COMMIT_INTERVAL_MS
        && paragraphRevealEnd(current0.length, target0, streaming) === null
      ) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const elapsed = Math.max(8, Math.min(80, now - last));
      lastFrameAtRef.current = now;

      const target = latestRef.current;
      const current = visibleRef.current;
      const jump = paragraphRevealEnd(current.length, target, streaming)
        ?? pressureRevealEnd(current.length, target, streaming, elapsed);
      if (jump !== null) {
        const next = target.slice(0, jump);
        visibleRef.current = next;
        carryRef.current = 0;
        setVisible(next);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (current.length < target.length) {
        const backlog = target.length - current.length;
        const targetDrainMs = streaming ? STREAM_TEXT_TARGET_DRAIN_MS : STREAM_TEXT_FINAL_DRAIN_MS;
        const minCps = streaming ? STREAM_TEXT_STREAMING_MIN_CPS : STREAM_TEXT_FINAL_MIN_CPS;
        const maxCps = streaming ? STREAM_TEXT_STREAMING_MAX_CPS : STREAM_TEXT_FINAL_MAX_CPS;
        const pressure = elapsed > STREAM_TEXT_PRESSURE_FRAME_MS || backlog > STREAM_TEXT_PRESSURE_BACKLOG;
        const maxFrameChars = pressure
          ? (streaming ? STREAM_TEXT_PRESSURE_MAX_FRAME_CHARS : STREAM_TEXT_FINAL_MAX_FRAME_CHARS)
          : (streaming ? STREAM_TEXT_STREAMING_MAX_FRAME_CHARS : STREAM_TEXT_FINAL_MAX_FRAME_CHARS);
        const charsPerSecond = clamp(
          backlog / (targetDrainMs / 1000),
          minCps,
          maxCps,
        );
        carryRef.current += charsPerSecond * (elapsed / 1000);
        const frameChars = clamp(
          Math.floor(carryRef.current),
          STREAM_TEXT_MIN_FRAME_CHARS,
          maxFrameChars,
        );
        carryRef.current = Math.max(0, carryRef.current - frameChars);
        const nextEnd = safeSliceEnd(
          target,
          Math.min(target.length, current.length + frameChars),
        );
        const next = target.slice(0, nextEnd);
        visibleRef.current = next;
        setVisible(next);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      stopLoop();
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [content, streaming, instant]);

  useEffect(() => {
    return stopLoop;
  }, []);

  return visible;
}

/**
 * Timeline text rendering boundary.
 *
 * cells/UserCell + AssistantTextCell own conversation layout; this component owns text presentation.
 * Keeping the boundary explicit lets us add streaming throttling, final-render
 * caching, code-block virtualization, or debug rendering without changing the
 * timeline node lifecycle again.
 */
const TimelineTextRenderer: React.FC<Props> = ({ content, streaming = false, className, instant = false }) => {
  const normalized = useTimelineTextContent(content || '', streaming, instant);
  const body = useMemo(() => (
    <Markdown content={fenceBareJson(normalized, streaming)} className={className ?? 'atl-msg__md'} incremental />
  ), [className, normalized, streaming]);

  return (
    <div
      className={`atl-text-renderer${streaming ? ' is-streaming' : ' is-final'}`}
      data-streaming={streaming ? 'true' : 'false'}
    >
      {body}
    </div>
  );
};

export default memo(TimelineTextRenderer);
