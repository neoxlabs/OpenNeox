import type { MutableRefObject } from "react";

const SCROLL_UP_KEYS = new Set(["PageUp", "ArrowUp", "Home"]);

export function bindUserScrollIntent(
  el: HTMLElement,
  opts: {
    pointerHeldRef: MutableRefObject<boolean>;
    onScrollAway: () => void;
  }
): () => void {
  const { pointerHeldRef, onScrollAway } = opts;
  const onKeyDown = (e: KeyboardEvent) => {
    if (SCROLL_UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey))
      onScrollAway();
  };
  const onPointerDown = () => {
    pointerHeldRef.current = true;
  };
  const onPointerUp = () => {
    pointerHeldRef.current = false;
  };
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointerup", onPointerUp, { passive: true });
  window.addEventListener("pointercancel", onPointerUp, { passive: true });
  return () => {
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    pointerHeldRef.current = false;
  };
}
