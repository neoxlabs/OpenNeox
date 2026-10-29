import { useEffect, useState, type RefObject } from 'react';

/** Suspend motion in hidden windows, offscreen panels and reduced-motion mode. */
export function useMascotActivity(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) {
      setActive(false);
      return;
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = typeof IntersectionObserver === 'undefined';
    const sync = () => setActive(visible && !document.hidden && !reduced.matches
      && document.documentElement.dataset.motion !== 'off' && element.dataset.crowded !== 'yes');
    const observer = typeof IntersectionObserver === 'undefined' ? null
      : new IntersectionObserver(entries => {
        visible = entries.some(entry => entry.isIntersecting);
        sync();
      });
    observer?.observe(element);
    const motionPrefs = new MutationObserver(sync);
    motionPrefs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    motionPrefs.observe(element, { attributes: true, attributeFilter: ['data-crowded'] });
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    sync();
    return () => {
      observer?.disconnect();
      motionPrefs.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
    };
  }, [enabled, ref]);
  return enabled && active;
}
