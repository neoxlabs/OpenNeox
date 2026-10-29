
import { useEffect } from 'react';
import { subscribeFsEvents } from '../../../state/workspaceFsEventLog';

export function useAutoReloadOnFsChange(
  sourcePath: string | null | undefined,
  onReload: () => void,
  debounceMs = 300,
): void {
  useEffect(() => {
    if (!sourcePath) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeFsEvents((ev) => {
      if (ev.path !== sourcePath) return;
      if (ev.kind !== 'add' && ev.kind !== 'change') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onReload();
      }, debounceMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [sourcePath, onReload, debounceMs]);
}
