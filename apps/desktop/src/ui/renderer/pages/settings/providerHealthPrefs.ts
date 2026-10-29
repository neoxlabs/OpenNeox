import { useEffect, useState } from 'react';

const KEY_PREFIX = 'neox.provider-health.skip:';
const VALUE_SKIPPED = '1';
const EVENT_NAME = 'neox-provider-health-prefs-changed';

export function isProviderHealthCheckSkipped(providerId: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(KEY_PREFIX + providerId) === VALUE_SKIPPED;
}

export function setProviderHealthCheckSkipped(providerId: string, skipped: boolean): void {
  if (typeof localStorage === 'undefined') return;
  if (skipped) localStorage.setItem(KEY_PREFIX + providerId, VALUE_SKIPPED);
  else localStorage.removeItem(KEY_PREFIX + providerId);
  notifyProviderHealthPrefsChanged();
}

function notifyProviderHealthPrefsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
  }
}

export function useProviderHealthPrefsVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion(v => v + 1);
    window.addEventListener(EVENT_NAME, bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener(EVENT_NAME, bump);
      window.removeEventListener('storage', bump);
    };
  }, []);
  return version;
}
