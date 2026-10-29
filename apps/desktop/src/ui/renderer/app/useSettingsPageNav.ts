import { useCallback, useEffect } from 'react';

const INITIAL_TAB_KEY = 'neox-settings-initial-tab';

export function useSettingsPageNav(setAgentPage: (page: 'settings') => void) {
  const handleOpenSettingsPage = useCallback((tab?: string) => {
    if (tab) { try { localStorage.setItem(INITIAL_TAB_KEY, tab); } catch { /* ignore */ } }
    setAgentPage('settings');
  }, [setAgentPage]);

  useEffect(() => {
    const handler = (e: Event) => handleOpenSettingsPage((e as CustomEvent<{ tab?: string }>).detail?.tab);
    window.addEventListener('neox:open-settings', handler);
    return () => window.removeEventListener('neox:open-settings', handler);
  }, [handleOpenSettingsPage]);

  return handleOpenSettingsPage;
}
