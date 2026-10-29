import { useEffect, type RefObject } from 'react';
import { crowdingRects } from './mascotRoam';

/** Anchor the actual paws to the actual box, not to pills/banners above its wrapper. */
export function useMascotAnchor(
  ref: RefObject<HTMLElement | null>, scopeRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean, size: number,
) {
  // The composer's ancestor ref is attached after child layout effects.
  useEffect(() => {
    const root = ref.current;
    const scope = scopeRef?.current;
    if (!root || !scope || !enabled) return;
    let frame = 0;
    const set = (name: string, value: number) => {
      const next = `${value.toFixed(2)}px`;
      if (root.style.getPropertyValue(name) !== next) root.style.setProperty(name, next);
    };
    let observedBox: Element | null = null;
    const sync = () => {
      const box = scope.querySelector<HTMLElement>('.atl-composer__box');
      if (!box) return;
      if (box !== observedBox) {
        if (observedBox) observer?.unobserve(observedBox);
        observer?.observe(box);
        observedBox = box;
      }
      const parent = scope.getBoundingClientRect();
      const edge = box.getBoundingClientRect();
      if (!parent.width || !edge.width) return;
      const scale = parent.width / (scope.offsetWidth || parent.width || 1);
      const width = size * 480 / 397;
      const top = (edge.top - parent.top) / scale - size * 389 / 397 + Math.min(6, size * .04);
      const preferredLeft = (edge.right - parent.left) / scale - width * 315 / 480 - 22;
      const viewportLimit = (document.documentElement.clientWidth - parent.left) / scale - width - 8;
      // An approval strip is waiting: step just past its right end, where the approve
      // button is, so the pointing paw (which reaches ~.14 of the width out) lands on it.
      const strip = scope.querySelector('.atl-approve')?.getBoundingClientRect();
      const besideLeft = strip?.width ? (strip.right - parent.left) / scale - width * .14 : -Infinity;
      const clampLeft = (x: number) => Math.max(-width * .2, Math.min(x, viewportLimit));
      // Queued prompts, approvals, task pills and menus take priority over decorative
      // art: where the face would cover one, step aside (past its right end, or along
      // the edge to the left while the paws stay on the box), and only hide when there
      // is no room either way.
      const obstacles = crowdingRects(root, scope, box);
      const faceTop = parent.top + (top + size * .18) * scale;
      const faceBottom = parent.top + (top + size * .86) * scale;
      const blocking = (x: number) => {
        const l = parent.left + (x + width * .23) * scale;
        const r = parent.left + (x + width * .78) * scale;
        return obstacles.filter(o => o.left < r && o.right > l && o.top < faceBottom && o.bottom > faceTop);
      };
      const minLeft = (edge.left - parent.left) / scale - width * .28;
      // Picked up or put down off the composer: the docked spot is only the origin the
      // drag offset is measured from, so it must not move under the pet.
      const loose = root.dataset.free === 'yes' || root.dataset.dragging === 'yes';
      const wanted = clampLeft(Math.max(preferredLeft, besideLeft));
      let left = loose && placed ? lastLeft : wanted;
      for (let tries = 0; tries < 6 && !loose; tries++) {
        const hit = blocking(left);
        if (!hit.length) break;
        const right = clampLeft((Math.max(...hit.map(o => o.right)) - parent.left) / scale - width * .23 + 4);
        const leftward = (Math.min(...hit.map(o => o.left)) - parent.left) / scale - width * .78 - 4;
        const options = [right, leftward >= minLeft ? leftward : NaN].filter(x => Number.isFinite(x) && x !== left);
        if (!options.length) break;
        left = options.reduce((a, b) => (Math.abs(b - left) < Math.abs(a - left) ? b : a));
      }
      const crowded = !loose && blocking(left).length > 0;
      set('--mascot-dock-top', top);
      set('--mascot-dock-left', left);
      root.dataset.docked = 'yes';
      root.dataset.crowded = crowded ? 'yes' : 'no';
      // approval: beside the strip, pointing at it; aside: stepped out of something's way.
      const beside = crowded || loose ? 'none' : strip?.width ? 'approval' : Math.abs(left - wanted) > 1 ? 'aside' : 'none';
      if (root.dataset.beside && root.dataset.beside !== beside && !loose) {
        // Walk over (and back) instead of jumping; see mascot.css. useMascotMotion
        // runs in this direction while the docked spot slides.
        root.dataset.stepDir = left < lastLeft ? 'left' : 'right';
        root.dataset.stepping = 'yes';
        window.clearTimeout(stepping);
        stepping = window.setTimeout(() => { delete root.dataset.stepping; }, 900);
      }
      if (root.dataset.beside !== beside) root.dataset.beside = beside;
      lastLeft = left;
      placed = true;
    };
    let stepping = 0;
    let lastLeft = 0;
    let placed = false;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; sync(); });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(scope);
    const mutations = new MutationObserver(schedule);
    mutations.observe(scope, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    // The column can slide without resizing (sidebar / rail transitions, the
    // composer's FLIP entrance). Size observers never see that, and the first
    // measurement is clamped against the window edge mid-slide, so re-measure
    // whenever a transition or animation settles, and once after mount.
    document.addEventListener('transitionend', schedule, true);
    document.addEventListener('animationend', schedule, true);
    const settle = window.setTimeout(schedule, 700);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      window.clearTimeout(stepping);
      delete root.dataset.stepping;
      document.removeEventListener('transitionend', schedule, true);
      document.removeEventListener('animationend', schedule, true);
      observer?.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      delete root.dataset.docked;
      delete root.dataset.crowded;
      delete root.dataset.beside;
      delete root.dataset.stepDir;
      root.style.removeProperty('--mascot-dock-top');
      root.style.removeProperty('--mascot-dock-left');
    };
  }, [ref, scopeRef, enabled, size]);
}
